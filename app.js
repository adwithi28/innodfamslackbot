require("dotenv").config();

const required = [
  "SLACK_BOT_TOKEN",
  "SLACK_APP_TOKEN",
  "SLACK_SIGNING_SECRET",
  "SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY"
];

for (const key of required) {
  if (!process.env[key]) {
    throw new Error(`Missing environment variable: ${key}`);
  }
}

const { App } = require("@slack/bolt");
const { createClient } = require("@supabase/supabase-js");

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  socketMode: true,
  appToken: process.env.SLACK_APP_TOKEN,
});

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const STORAGE_BUCKET = "submission-images";

async function getActiveSemesterId() {
  const { data, error } = await supabase
    .from("semesters")
    .select("id")
    .eq("is_active", true)
    .maybeSingle();

  if (error) throw error;
  if (!data?.id) throw new Error("No active semester found in Supabase.");

  return data.id;
}

function normalizeName(name) {
  return (name || "")
    .toLowerCase()
    .replace(/[^a-z\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

async function getSlackName(client, slackUserId) {
  const result = await client.users.info({ user: slackUserId });
  const profile = result.user.profile || {};

  return (
    profile.real_name_normalized ||
    profile.real_name ||
    profile.display_name_normalized ||
    profile.display_name ||
    result.user.name
  );
}

async function findOrLinkMemberBySlackUser(client, slackUserId, allMembers) {
  const linked = (allMembers || []).filter(
    m => m.slack_user_id === slackUserId
  );
  if (linked.length) return linked.length === 1 ? linked[0] : null;

  const slackName = await getSlackName(client, slackUserId);
  const normalizedSlackName = normalizeName(slackName);

  const matches = (allMembers || []).filter(
    m => !m.slack_user_id && normalizeName(m.name) === normalizedSlackName
  );
  const matched = matches.length === 1 ? matches[0] : null;

  if (!matched) return null;

  const { error: linkError } = await supabase
    .from("members")
    .update({
      slack_user_id: slackUserId,
      slack_display_name: slackName,
    })
    .eq("id", matched.id);

  if (linkError) throw linkError;

  return {
    ...matched,
    slack_user_id: slackUserId,
    slack_display_name: slackName,
  };
}

async function addReaction(client, channel, ts, name) {
  try {
    await client.reactions.add({
      channel,
      timestamp: ts,
      name,
    });
  } catch (err) {
    if (err.data?.error !== "already_reacted") {
      console.error("Reaction error:", err.data || err);
    }
  }
}

async function uploadSlackFileToSupabase(file) {
  const slackFileUrl = file.url_private_download || file.url_private;

  const response = await fetch(slackFileUrl, {
    headers: {
      Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}`,
    },
  });

  if (!response.ok) {
    throw new Error(`Could not download Slack file: ${response.status}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);

  const originalName = file.name || `${file.id}.jpg`;
  const ext = originalName.includes(".") ? originalName.split(".").pop() : "jpg";
  const path = `submissions/${Date.now()}-${file.id}.${ext}`;

  const { error } = await supabase.storage
    .from(STORAGE_BUCKET)
    .upload(path, buffer, {
      contentType: file.mimetype || "image/jpeg",
      upsert: false,
    });

  if (error) throw error;

  const { data } = supabase.storage
    .from(STORAGE_BUCKET)
    .getPublicUrl(path);

  return data.publicUrl;
}

const { extractActivities, matchTask, normalizeMessage } = require("./activities");

app.event("message", async ({ event, client }) => {
  const message = normalizeMessage(event);
  if (!message?.user || !message.ts || !message.channel) return;
  try {
    const { data: existing, error: lookupError } = await supabase
      .from("point_submissions").select("id, source_version, source_files, semester_id")
      .eq("slack_channel_id", message.channel).eq("slack_message_ts", message.ts).maybeSingle();
    if (lookupError) throw lookupError;
    if (existing?.source_version && Number(existing.source_version) >= Number(message.sourceVersion)) return;
    const files = (message.files || []).filter(f => f.mimetype?.startsWith("image/"));
    if (!files.length && !existing) return;
    const semesterId = existing?.semester_id || await getActiveSemesterId();
    const [{ data: members, error: membersError }, { data: tasks, error: tasksError }] = await Promise.all([
      supabase.from("members").select("id, name, slack_user_id, slack_display_name"),
      supabase.from("tasks").select("id, name, points")
    ]);
    if (membersError || tasksError) throw membersError || tasksError;
    const parsed = extractActivities(message.text || "", message.user);
    const resolved = new Map();
    for (const id of new Set(parsed.flatMap(item => [...item.recipientSlackIds, item.targetSlackId].filter(Boolean)))) {
      resolved.set(id, await findOrLinkMemberBySlackUser(client, id, members));
    }
    const items = parsed.map(activity => {
      const task = matchTask(activity.category, tasks);
      const issues = [...activity.issues];
      if (!task) issues.push(`Select a task for ${activity.category || "this activity"}; no unique matching task was found.`);
      for (const id of activity.recipientSlackIds) if (!resolved.get(id)) issues.push(`Recipient ${id} could not be matched to a member.`);
      const target = resolved.get(activity.targetSlackId);
      return {
        inferred_task_id: task?.id || null, final_task_id: task?.id || null,
        member_ids: [...new Set(activity.recipientSlackIds.map(id => resolved.get(id)?.id).filter(Boolean))],
        target_slack_id: activity.targetSlackId || null,
        target_name: target?.name || activity.targetSlackId || null,
        confidence: issues.length ? 0.3 : 0.8,
        needs_review: issues.length > 0,
        notes: [activity.evidence, ...issues, "Photo-to-activity mapping is unconfirmed; review the submission photos."].filter(Boolean).join("\n")
      };
    });
    const sourceFiles = [];
    for (const file of files) {
      const cached = (existing?.source_files || []).find(f => f.id === file.id);
      sourceFiles.push(cached || { id: file.id, url: await uploadSlackFileToSupabase(file) });
    }
    const { data: result, error } = await supabase.rpc("save_slack_submission", {
      p_submission: {
        slack_message_ts: message.ts, slack_channel_id: message.channel,
        slack_user_id: message.user, caption: message.text || "",
        image_urls: sourceFiles.map(f => f.url), source_files: sourceFiles,
        source_version: message.sourceVersion, semester_id: semesterId
      }, p_items: items
    });
    if (error) throw error;
    if (result === "unchanged") return;
    await addReaction(client, message.channel, message.ts, result === "review_required" ? "warning" : "eyes");
    const summary = items.map((item, index) => {
      const category = parsed[index].category || "Needs review";
      const names = item.member_ids.map(id => members.find(m => m.id === id)?.name || "Unmatched member");
      return `• ${category}${item.target_name ? ` (target: ${item.target_name})` : ""}: ${names.join(", ") || "select recipients"}${item.needs_review ? " — review needed" : ""}`;
    }).join("\n");
    await client.chat.postMessage({
      channel: message.channel, thread_ts: message.ts,
      text: result === "review_required"
        ? "⚠️ This message changed after review. Existing points are unchanged; check Pending Logs to reconcile the edit."
        : `👀 ${items.length} activities saved to Pending Logs.\n${summary}`
    });
    console.log("Submission saved:", result, "activities:", items.length);
  } catch (err) {
    console.error("Submission failed:", err.message);
    await addReaction(client, message.channel, message.ts, "warning");
  }
});

(async () => {
  await app.start();
  console.log("⚡ Fam Points Bot is running");
})();
