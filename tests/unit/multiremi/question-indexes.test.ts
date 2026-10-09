import { expect, it } from 'bun:test';
import { pendingTurnBackendTests } from './pending-turn-test-backends.js';
import { ensureQuestionQueryIndexes, questionMetadataText } from '@multiremi/store/inbox/question-indexes.js';
import { MultiremiStore } from '@multiremi/store.js';

pendingTurnBackendTests('safe historical question indexes', fixture => {
  it('preserves malformed historical TEXT through updates and repeated index installation', () => {
    const { store, db } = fixture();
    const agent = store.createAgent({ name: 'Historical metadata', provider: 'codex' });
    const issue = fixture().createIssue({ title: 'Historical question index' });
    const session = store.getOrCreateDefaultIssueSession(issue.id);
    const row = store.appendConversationLog({ sessionId: session.id, kind: 'message', messageKind: 'decision',
      authorType: 'agent', authorId: agent.id, bodyMd: 'Original question stays intact', metadata: {} });
    const values = ['{"inbox":', 'not-json', '{"root_question_id":"msg_original","unrelated":"\\u0000"}',
      '{"question":{"wait":{"runtime_id":"rt_original"}},"unrelated":"\\ud800"}'];
    for (const metadata of values) {
      db.run('UPDATE multiremi_conversation_log SET metadata=? WHERE id=?', [metadata, row.id]);
      ensureQuestionQueryIndexes(db); ensureQuestionQueryIndexes(db);
      expect(db.query('SELECT metadata,body_md FROM multiremi_conversation_log WHERE id=?').get(row.id))
        .toEqual({ metadata, body_md: 'Original question stays intact' });
      const root = db.query(`SELECT ${questionMetadataText(db, 'metadata', 'root_question_id')} AS root FROM multiremi_conversation_log WHERE id=?`).get(row.id);
      expect(root?.root).toBe(metadata.includes('msg_original') ? 'msg_original' : null);
      const runtime = db.query(`SELECT ${questionMetadataText(db, 'metadata', 'question.wait.runtime_id')} AS runtime FROM multiremi_conversation_log WHERE id=?`).get(row.id);
      expect(runtime?.runtime).toBe(metadata.includes('rt_original') ? 'rt_original' : null);
      expect(store.listIssueQuestions(issue.id)).toEqual([]);
    }
    const expression = questionMetadataText(db, 'metadata', 'root_question_id');
    const plan = db.dialect === 'postgres'
      ? JSON.stringify(db.query(`EXPLAIN SELECT id FROM multiremi_conversation_log WHERE kind='message' AND deleted_at IS NULL AND session_id=? AND ${expression}=?`).all(session.id, 'msg_original'))
      : JSON.stringify(db.query(`EXPLAIN QUERY PLAN SELECT id FROM multiremi_conversation_log WHERE kind='message' AND deleted_at IS NULL AND session_id=? AND ${expression}=?`).all(session.id, 'msg_original'));
    expect(plan).toContain('idx_questions_session_notification_v2');
    db.run('UPDATE multiremi_conversation_log SET metadata=? WHERE id=?', ['not-json', row.id]);
    new MultiremiStore(db); new MultiremiStore(db);
    expect(db.query('SELECT metadata FROM multiremi_conversation_log WHERE id=?').get(row.id)?.metadata).toBe('not-json');
  });
});
