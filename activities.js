// A caption describes occurrences, not one category or one shared recipient list.
const mentions = text => [...new Set([...text.matchAll(/<@([A-Z0-9]+)(?:\|[^>]+)?>/g)].map(m => m[1]))];
const normalize = text => (text || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

function extractActivities(caption, senderId) {
  const items = [];
  // Split at category markers as well as explicit separators. A leading bare tag
  // list is the club's snipe convention; tags after a category belong to that item.
  const marker = /\b(?:reach[ -]?out\s+(?:cc|coffee(?:\s+chat)?)|coffee(?:\s+chat)?|cc|big[ /-]little|fam\s+hangout|hangout|snipes?|sniped)\b/gi;
  const segments = [];
  for (const line of (caption || '').split(/[+;\n]+/)) {
    const matches = [...line.matchAll(marker)];
    if (!matches.length) { if (line.trim()) segments.push({ text: line, category: null }); continue; }
    const prefix = line.slice(0, matches[0].index);
    if (prefix.trim()) segments.push({ text: prefix, category: null });
    matches.forEach((m, i) => segments.push({ category: normalize(m[0]), text: line.slice(m.index, matches[i + 1]?.index ?? line.length) }));
  }
  for (const segment of segments) {
    const ids = mentions(segment.text);
    const bareTags = !segment.category && segment.text.replace(/<@[^>]+>/g, '').replace(/[\s,&.!:]+/g, '') === '';
    const isSnipe = bareTags || /^snip/.test(segment.category || '');
    if (isSnipe && ids.length) {
      for (const target of ids) items.push({ category: 'Snipe', recipientSlackIds: [senderId], targetSlackId: target, evidence: segment.text.trim(), issues: target === senderId ? ['Sender is also the snipe target; verify this occurrence.'] : [] });
    } else if (segment.category && !isSnipe) {
      const category = /reach/.test(segment.category) ? 'Reach-out Coffee Chat' : /coffee|^cc$/.test(segment.category) ? 'Coffee Chat' : /big/.test(segment.category) ? 'Big Little' : 'Fam Hangout';
      items.push({ category, recipientSlackIds: [...new Set([senderId, ...ids])], evidence: segment.text.trim(), issues: ids.length ? [] : ['No tagged participant; select recipients before approving.'] });
    } else {
      items.push({ category: isSnipe ? 'Snipe' : null, recipientSlackIds: isSnipe ? [senderId] : [], evidence: segment.text.trim(), issues: ['Caption is ambiguous. Split activities and confirm recipients manually.'] });
    }
  }
  if (!items.length) items.push({ category: null, recipientSlackIds: [], evidence: '', issues: ['Photos alone do not establish activity count or recipients.'] });
  return items;
}

function matchTask(category, tasks) {
  const aliases = {
    'Snipe': ['snipe', 'snipes'],
    'Coffee Chat': ['coffee chat', 'cc'],
    'Reach-out Coffee Chat': ['reach out coffee chat', 'reachout coffee chat', 'reach out cc', 'reachout cc'],
    'Big Little': ['big little'], 'Fam Hangout': ['fam hangout', 'hangout']
  };
  const matches = tasks.filter(t => (aliases[category] || []).includes(normalize(t.name)));
  return matches.length === 1 ? matches[0] : null;
}

function normalizeMessage(event) {
  if (event.subtype === 'message_changed') {
    const message = event.message;
    if (!message || message.bot_id || (message.subtype && message.subtype !== 'file_share')) return null;
    return { ...message, channel: event.channel, files: message.files ?? event.previous_message?.files, sourceVersion: message.edited?.ts || event.event_ts || event.ts };
  }
  if (event.bot_id || (event.subtype && event.subtype !== 'file_share')) return null;
  return { ...event, sourceVersion: event.edited?.ts || event.ts };
}

module.exports = { extractActivities, matchTask, normalizeMessage, mentions };
