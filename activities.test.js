const { test } = require('node:test');
const assert = require('node:assert/strict');
const { extractActivities, matchTask, normalizeMessage } = require('./activities');

test('a name before snipe stays in one activity', () => {
  const items = extractActivities('cc with aaron + anushka snipe', 'UJ');
  assert.deepEqual(items.map(i => i.category), ['Reach-out Coffee Chat', 'Snipe']);
  assert.equal(items[1].evidence, 'anushka snipe');
  assert.deepEqual(items[1].recipientSlackIds, ['UJ']);
  assert.ok(items.every(i => i.issues.length));
});
test('a trailing snipe category binds its tagged target without an extra item', () => {
  const items = extractActivities('cc with <@UA> + <@UB> snipe!', 'UJ');
  assert.deepEqual(items.map(i => i.category), ['Reach-out Coffee Chat', 'Snipe']);
  assert.deepEqual(items[0].recipientSlackIds, ['UJ', 'UA']);
  assert.equal(items[1].targetSlackId, 'UB');
  assert.deepEqual(items[1].recipientSlackIds, ['UJ']);
  assert.deepEqual(items[1].issues, []);
});
test('a trailing assigned coffee category applies to its preceding tag', () => {
  const items = extractActivities('<@UA> assigned cc', 'UJ');
  assert.equal(items.length, 1);
  assert.equal(items[0].category, 'Assigned Coffee Chat');
  assert.deepEqual(items[0].recipientSlackIds, ['UJ', 'UA']);
});

test('coffee keywords distinguish reach-out from assigned chats', () => {
  for (const keyword of ['cc', 'coffee chat', 'CC', 'reach out cc']) {
    const items = extractActivities(`${keyword} with <@UA>`, 'UJ');
    assert.equal(items.length, 1);
    assert.equal(items[0].category, 'Reach-out Coffee Chat');
    assert.deepEqual(items[0].recipientSlackIds, ['UJ', 'UA']);
  }
  for (const keyword of ['assigned cc', 'assigned coffee chat', 'ASSIGNED CC']) {
    const items = extractActivities(`${keyword} with <@UA>`, 'UJ');
    assert.equal(items.length, 1);
    assert.equal(items[0].category, 'Assigned Coffee Chat');
    assert.deepEqual(items[0].recipientSlackIds, ['UJ', 'UA']);
  }
});
test('bare tags, assigned cc, and default cc stay separate in one message', () => {
  const items = extractActivities('<@UA> <@UB> + assigned cc <@UC> + coffee chat <@UD>', 'UJ');
  assert.deepEqual(items.map(i => i.category), ['Snipe', 'Snipe', 'Assigned Coffee Chat', 'Reach-out Coffee Chat']);
  assert.deepEqual(items.map(i => i.recipientSlackIds), [['UJ'], ['UJ'], ['UJ', 'UC'], ['UJ', 'UD']]);
});
test('assigned and reach-out task IDs remain distinct', () => {
  const tasks = [{id:'a',name:'Assigned CC'}, {id:'r',name:'Reach Out Coffee Chat'}];
  assert.equal(matchTask('Assigned Coffee Chat', tasks).id, 'a');
  assert.equal(matchTask('Reach-out Coffee Chat', tasks).id, 'r');
  assert.equal(matchTask('Assigned Coffee Chat', [tasks[1]]), null);
});

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
