require("dotenv").config();

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

function getTaggedSlackIds(text) {
  return [...(text || "").matchAll(/<@([A-Z0-9]+)>/g)].map(match => match[1]);
}

function inferActivities(text, fileCount) {
  const t = (text || "").toLowerCase();
  const activities = [];

  if (/\bcc\b|coffee chat|coffee/.test(t)) activities.push("Coffee Chat");
  if (/big little|big\/little|big-little/.test(t)) activities.push("Big Little");
  if (/fam hangout|hangout/.test(t)) activities.push("Fam Hangout");

  if (activities.length === 0 && fileCount > 0) activities.push("Snipe");

  return [...new Set(activities)];
}

function findMembersNamedInCaption(caption, members) {
  const text = normalizeName(caption);

  return (members || []).filter(member => {
    const fullName = normalizeName(member.name);
    const firstName = normalizeName(member.name.split(" ")[0]);

    return (
      (fullName.length > 2 && text.includes(fullName)) ||
      (firstName.length > 2 && text.includes(firstName))
    );
  });
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
  const alreadyLinked = (allMembers || []).find(
    m => m.slack_user_id === slackUserId
  );

  if (alreadyLinked) return alreadyLinked;

  const slackName = await getSlackName(client, slackUserId);
  const normalizedSlackName = normalizeName(slackName);

  const matched = (allMembers || []).find(
    m => normalizeName(m.name) === normalizedSlackName
  );

  if (!matched) return null;

  await supabase
    .from("members")
    .update({
      slack_user_id: slackUserId,
      slack_display_name: slackName,
    })
    .eq("id", matched.id);

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

app.message(async ({ message, client, say }) => {
  console.log("MESSAGE:", {
    text: message.text,
    channel: message.channel,
    hasFiles: !!message.files,
    files: message.files?.length || 0,
    subtype: message.subtype,
  });

  if (message.subtype && message.subtype !== "file_share") return;

  const hasFiles = message.files && message.files.length > 0;

  if (!hasFiles) {
    console.log("Ignoring message with no files.");
    return;
  }

  try {
    console.log("STARTING SUBMISSION PROCESS");

    const activeSemesterId = await getActiveSemesterId();
    console.log("Active semester:", activeSemesterId);

    const caption = message.text || "";
    const activityNames = inferActivities(caption, message.files.length);

    console.log("UPLOADING IMAGES");

    const imageUrls = [];

    for (const file of message.files) {
      const publicUrl = await uploadSlackFileToSupabase(file);
      imageUrls.push(publicUrl);
    }

    console.log("Detected activities:", activityNames);

    const { data: existing, error: existingError } = await supabase
      .from("point_submissions")
      .select("id")
      .eq("slack_message_ts", message.ts)
      .maybeSingle();

    if (existingError) throw existingError;

    if (existing) {
      console.log("Submission already exists.");
      await addReaction(client, message.channel, message.ts, "eyes");
      return;
    }

    console.log("FETCHING MEMBERS");

    const { data: allMembers, error: membersError } = await supabase
      .from("members")
      .select(
        "id, name, slack_user_id, slack_display_name, member_semesters(fam_id, semester_id)"
      );

    if (membersError) throw membersError;

    console.log("Members loaded:", allMembers?.length || 0);

    const taggedSlackIds = getTaggedSlackIds(caption);
    const matchedMembers = [];

    for (const slackId of taggedSlackIds) {
      const member = await findOrLinkMemberBySlackUser(client, slackId, allMembers);

      if (member && !matchedMembers.find(m => m.id === member.id)) {
        matchedMembers.push(member);
      }
    }

    const typedNameMembers = findMembersNamedInCaption(caption, allMembers);

    for (const member of typedNameMembers) {
      if (!matchedMembers.find(m => m.id === member.id)) {
        matchedMembers.push(member);
      }
    }

    const senderMember = await findOrLinkMemberBySlackUser(
      client,
      message.user,
      allMembers
    );

    if (senderMember && !matchedMembers.find(m => m.id === senderMember.id)) {
      matchedMembers.push(senderMember);
    }

    console.log(
      "Matched members:",
      matchedMembers.map(m => m.name)
    );

    const famCounts = {};

    for (const member of matchedMembers) {
      const sem = (member.member_semesters || []).find(
        ms => ms.semester_id === activeSemesterId
      );

      if (!sem?.fam_id) continue;

      famCounts[sem.fam_id] = (famCounts[sem.fam_id] || 0) + 1;
    }

    console.log("Fam counts:", famCounts);

    console.log("CREATING SUBMISSION");

    const { data: submission, error: submissionError } = await supabase
      .from("point_submissions")
      .insert({
        slack_message_ts: message.ts,
        slack_channel_id: message.channel,
        slack_user_id: message.user,
        caption,
        image_urls: imageUrls,
        status: "pending",
        semester_id: activeSemesterId,
      })
      .select()
      .single();

    if (submissionError) throw submissionError;

    console.log("Submission created:", submission.id);

    console.log("FETCHING TASKS");

    const { data: tasks, error: tasksError } = await supabase
      .from("tasks")
      .select("id, name, points");

    if (tasksError) throw tasksError;

    console.log("Tasks loaded:", tasks?.length || 0);

    for (const activityName of activityNames) {
      const task = (tasks || []).find(
        t => t.name.toLowerCase() === activityName.toLowerCase()
      );

      const { data: item, error: itemError } = await supabase
        .from("point_submission_items")
        .insert({
          submission_id: submission.id,
          inferred_task_id: task?.id || null,
          final_task_id: task?.id || null,
          confidence: task ? 0.8 : 0.3,
          notes: `Detected: ${activityName}. Matched members: ${
            matchedMembers.map(m => m.name).join(", ") || "none"
          }.`,
        })
        .select()
        .single();

      if (itemError) throw itemError;

      const memberRows = matchedMembers.map(member => ({
        item_id: item.id,
        member_id: member.id,
      }));

      if (memberRows.length > 0) {
        const { error: memberInsertError } = await supabase
          .from("point_submission_item_members")
          .insert(memberRows);

        if (memberInsertError) throw memberInsertError;
      }

      const countRows = Object.entries(famCounts).map(([famId, count]) => ({
        item_id: item.id,
        fam_id: famId,
        member_count: count,
      }));

      if (countRows.length > 0) {
        const { error: countError } = await supabase
          .from("point_submission_item_fam_counts")
          .insert(countRows);

        if (countError) throw countError;
      }
    }

    console.log("ADDING REACTION");

    await addReaction(client, message.channel, message.ts, "eyes");

    await say({
      text: `👀 Added to Pending Logs. Detected: ${activityNames.join(
        ", "
      )}. Matched ${matchedMembers.length} member(s).`,
      thread_ts: message.ts,
    });

    console.log("DONE");
  } catch (err) {
    console.error("Submission error full:", JSON.stringify(err, null, 2));
    console.error("Submission error message:", err.message);

    await addReaction(client, message.channel, message.ts, "warning");

    await say({
      text: `⚠️ Could not add to Pending Logs: ${err.message}`,
      thread_ts: message.ts,
    });
  }
});

(async () => {
  await app.start();
  console.log("⚡ Fam Points Bot is running");
})();