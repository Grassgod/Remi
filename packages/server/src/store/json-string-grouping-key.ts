/**
 * PG text cannot represent JSON's NUL or lone UTF-16 surrogates. Its json
 * getters also decode unrelated fields, so even valid json can throw there.
 * Tokenize a validated object without unescaping it, select the LAST top-level
 * field (JSON.parse duplicate-key semantics), then encode only that string as
 * UTF-16 hex. The key is injective and identical for equivalent JSON escapes;
 * neither unrelated values nor a decoded NUL/surrogate leave the database.
 * SQL expressions/field names are internal constants, never request input.
 */
export function postgresJsonStringGroupingKey(expression: string, field: string): string {
  const fieldPattern = '"' + [...field].map(char => {
    const hex = char.charCodeAt(0).toString(16).padStart(4, "0").replace(/[a-f]/g, c => `[${c}${c.toUpperCase()}]`);
    return `(?:${char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}|\\\\u${hex})`;
  }).join("") + '"';
  const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;
  const rawString = String.raw`(
    WITH tokens AS (
      SELECT token[1] AS token, ordinal
      FROM regexp_matches(CASE WHEN ${expression} IS JSON OBJECT THEN ${expression} ELSE '{}' END,
        '"(?:[^"\\]|\\.)*"|[{}\[\]:,]|true|false|null|-?[0-9]+(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?', 'g')
        WITH ORDINALITY AS scanned(token, ordinal)
    ), positions AS (
      SELECT token, ordinal,
        SUM(CASE WHEN token IN ('{', '[') THEN 1 WHEN token IN ('}', ']') THEN -1 ELSE 0 END)
          OVER (ORDER BY ordinal ROWS UNBOUNDED PRECEDING) AS depth,
        LEAD(token) OVER (ORDER BY ordinal) AS separator,
        LEAD(token, 2) OVER (ORDER BY ordinal) AS value
      FROM tokens
    ), selected AS (
      SELECT value FROM positions WHERE depth = 1 AND token ~ ${literal('^' + fieldPattern + '$')} AND separator = ':'
      ORDER BY ordinal DESC LIMIT 1
    ) SELECT value FROM selected
  )`;
  // Most rows contain ordinary JSON. Keep their indexed-field extraction
  // cheap; pg_input_is_valid safely routes nonrepresentable JSON to the lexer.
  const fieldLiteral = literal(field);
  return String.raw`(
    WITH selected AS (
      SELECT CASE WHEN pg_input_is_valid(${expression}, 'jsonb') THEN
        CASE WHEN jsonb_typeof((${expression})::jsonb -> ${fieldLiteral}) = 'string'
          THEN ((${expression})::jsonb -> ${fieldLiteral})::text END
        ELSE ${rawString} END AS value
    ), units AS (
      SELECT part[1] AS part, ordinal
      FROM selected, LATERAL regexp_matches(
        CASE WHEN LEFT(value, 1) = '"' THEN SUBSTRING(value FROM 2 FOR LENGTH(value) - 2) END,
        '\\u[0-9a-fA-F]{4}|\\.|[^\\]', 'g') WITH ORDINALITY AS scanned(part, ordinal)
    )
    SELECT CASE WHEN LEFT((SELECT value FROM selected), 1) = '"' THEN COALESCE(STRING_AGG(
      CASE WHEN part ~ '^\\u[0-9a-fA-F]{4}$' THEN LOWER(SUBSTRING(part FROM 3))
           WHEN LEFT(part, 1) = '\' THEN LPAD(TO_HEX(CASE SUBSTRING(part FROM 2)
             WHEN 'b' THEN 8 WHEN 'f' THEN 12 WHEN 'n' THEN 10 WHEN 'r' THEN 13 WHEN 't' THEN 9
             ELSE ASCII(SUBSTRING(part FROM 2)) END), 4, '0')
           WHEN ASCII(part) > 65535 THEN
             TO_HEX(55296 + ((ASCII(part) - 65536) / 1024)) || TO_HEX(56320 + ((ASCII(part) - 65536) % 1024))
           ELSE LPAD(TO_HEX(ASCII(part)), 4, '0') END,
      '' ORDER BY ordinal), '') END
    FROM units
  )`;
}
