import type { SqlDatabase } from '../db/postgres.js';

/** Fixed-type JSON parsing is immutable; malformed historical TEXT is no Q fact. */
export function questionMetadataText(db: SqlDatabase, expression: string, path: string): string {
  return db.dialect === 'postgres' ? `multiremi_question_metadata_text(${expression},'{${path.replaceAll('.', ',')}}')`
    : `json_extract(CASE WHEN json_valid(${expression}) THEN ${expression} ELSE '{}' END,'$.${path}')`;
}

/** Bound Q reads to Issue sessions and related notification roots on both backends. */
export function ensureQuestionQueryIndexes(db: SqlDatabase): void {
  if (db.dialect === 'postgres') db.query(`CREATE OR REPLACE FUNCTION multiremi_question_metadata_text(value TEXT, path TEXT[])
    RETURNS TEXT LANGUAGE plpgsql IMMUTABLE STRICT PARALLEL SAFE AS $$
    DECLARE raw TEXT := value; part TEXT; tokens TEXT[]; found TEXT; key TEXT;
      i INTEGER; j INTEGER; depth INTEGER;
    BEGIN
      BEGIN RETURN value::jsonb #>> path;
      EXCEPTION WHEN data_exception THEN NULL;
      END;
      -- Valid JSON can contain NUL or lone surrogates in an unrelated field.
      -- Tokenize that uncommon case without decoding other values, and retain
      -- the last matching property just like JSON.parse and jsonb.
      FOREACH part IN ARRAY path LOOP
        IF NOT (raw IS JSON OBJECT) THEN RETURN NULL; END IF;
        tokens := ARRAY(SELECT matched[1] FROM regexp_matches(raw,
          '"(?:[^"\\\\]|\\\\.)*"|[{}\\[\\]:,]|true|false|null|-?[0-9]+(?:\\.[0-9]+)?(?:[eE][+-]?[0-9]+)?', 'g') AS matched);
        i := 2; found := NULL;
        WHILE i < array_length(tokens,1) LOOP
          IF left(tokens[i],1)='"' AND tokens[i+1]=':' THEN
            BEGIN key := tokens[i]::jsonb #>> '{}';
            EXCEPTION WHEN data_exception THEN key := NULL;
            END;
            j := i+2;
            IF tokens[j] IN ('{','[') THEN
              depth := 1;
              WHILE depth > 0 LOOP
                j := j+1;
                IF tokens[j] IN ('{','[') THEN depth := depth+1;
                ELSIF tokens[j] IN ('}',']') THEN depth := depth-1; END IF;
              END LOOP;
            END IF;
            IF key=part THEN found := array_to_string(tokens[i+2:j],''); END IF;
            i := j+1;
          ELSE i := i+1; END IF;
        END LOOP;
        IF found IS NULL THEN RETURN NULL; END IF;
        raw := found;
      END LOOP;
      BEGIN RETURN raw::jsonb #>> '{}';
      EXCEPTION WHEN data_exception THEN RETURN NULL;
      END;
    END $$;`).run();
  db.exec(`CREATE INDEX IF NOT EXISTS idx_questions_session_page ON multiremi_conversation_log(session_id,created_at,id)
    WHERE message_kind='decision' AND deleted_at IS NULL;
    CREATE INDEX IF NOT EXISTS idx_questions_issue_subtree ON multiremi_issues(workspace_id,parent_issue_id,id);`);
  const root = questionMetadataText(db, 'metadata', 'root_question_id');
  const runtime = questionMetadataText(db, 'metadata', 'question.wait.runtime_id');
  // v1 extracted unguarded TEXT on every row, including old turn metadata.
  // Replace those exact indexes once; every bootstrap installs v2 idempotently.
  db.exec(`DROP INDEX IF EXISTS idx_questions_session_notification;
    DROP INDEX IF EXISTS idx_questions_runtime_wait;
    CREATE INDEX IF NOT EXISTS idx_questions_session_notification_v2 ON multiremi_conversation_log(session_id,${root}) WHERE kind='message' AND deleted_at IS NULL;
    CREATE INDEX IF NOT EXISTS idx_questions_runtime_wait_v2 ON multiremi_conversation_log(${runtime}) WHERE message_kind='decision' AND deleted_at IS NULL;`);
}
