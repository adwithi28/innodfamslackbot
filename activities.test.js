const { test } = require('node:test');
const assert = require('node:assert/strict');
const { extractActivities, matchTask, normalizeMessage } = require('./activities');

test('Julia screenshot: five sender awards and a separate reach-out coffee chat', () => {
  const items = extractActivities('<@UA> <@UJES> <@UJON> <@UR> <@UAD> +reach out cc with <@UC>', 'UJULIA');
  assert.equal(items.length, 6);
  assert.deepEqual(items.slice(0, 5).map(i => i.targetSlackId), ['UA', 'UJES', 'UJON', 'UR', 'UAD']);
  items.slice(0, 5).forEach(i => {
    assert.equal(i.category, 'Snipe');
    assert.deepEqual(i.recipientSlackIds, ['UJULIA']);
    assert.deepEqual(i.issues, []);
  });
  assert.equal(items[5].category, 'Reach-out Coffee Chat');
  assert.deepEqual(items[5].recipientSlackIds, ['UJULIA', 'UC']);
});
test('mixed categories without plus still keep the leading targets separate', () => {
  const items = extractActivities('<@UA> <@UB> coffee chat with <@UC>', 'UJ');
  assert.equal(items.length, 3);
  assert.deepEqual(items[2].recipientSlackIds, ['UJ', 'UC']);
});
test('explicit repeated occurrences with the same target are preserved', () => {
  assert.equal(extractActivities('snipe <@UA>; snipe <@UA>', 'UJ').length, 2);
});
test('duplicate mentions inside an occurrence are not extra points', () => {
  assert.equal(extractActivities('snipe <@UA> <@UA>', 'UJ').length, 1);
});
test('multiple coffee chats have independent recipients', () => {
  const items = extractActivities('cc <@UA> + cc <@UB>', 'UJ');
  assert.deepEqual(items.map(i => i.recipientSlackIds), [['UJ', 'UA'], ['UJ', 'UB']]);
});
test('plain names, missing targets, and photos-only remain reviewable', () => {
  for (const caption of ['', 'snipe', 'Aaron and Jeslyn', 'coffee with Aaron']) {
    assert.ok(extractActivities(caption, 'UJ').every(i => i.issues.length > 0));
  }
});
test('reach-out category never silently falls back to generic coffee', () => {
  assert.equal(matchTask('Reach-out Coffee Chat', [{id: 'c', name: 'Coffee Chat'}]), null);
  assert.equal(matchTask('Reach-out Coffee Chat', [{id: 'r', name: 'Reach Out CC'}]).id, 'r');
  assert.equal(matchTask('Snipe', [{id: 'a', name: 'Snipe'}, {id: 'b', name: 'Snipes'}]), null);
});
test('edits use nested message identity and retain attachments omitted from edit event', () => {
  const files = [{id: 'F1'}];
  const result = normalizeMessage({subtype: 'message_changed', channel: 'C1', ts: '200.1', message: {user: 'UJ', ts: '100.1', edited: {ts: '199.1'}, text: 'new'}, previous_message: {files}});
  assert.equal(result.ts, '100.1');
  assert.equal(result.sourceVersion, '199.1');
  assert.deepEqual(result.files, files);
});
test('bot and unrelated subtype events are ignored', () => {
  assert.equal(normalizeMessage({bot_id:'B'}), null);
  assert.equal(normalizeMessage({subtype:'message_deleted'}), null);
});
