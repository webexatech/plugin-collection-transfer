import { findUnsafeExpression, findUnsafeExpressionInUi, findUnsafeTextsInUi, sqlProblem } from '../package-format';

describe('findUnsafeExpression', () => {
  it('allows plain translations', () => {
    expect(findUnsafeExpression('{{t("Created at")}}')).toBeUndefined();
    expect(findUnsafeExpression("{{ t('Title', { ns: 'client' }) }}")).toBeUndefined();
    expect(findUnsafeExpression({ uiSchema: { title: '{{t("ID")}}', enum: [{ label: 'Open' }] } })).toBeUndefined();
    expect(findUnsafeExpression('Plain title')).toBeUndefined();
  });

  it('flags any other expression, wherever it is', () => {
    expect(findUnsafeExpression('{{ alert(1) }}')).toBe('{{ alert(1) }}');
    expect(findUnsafeExpression('{{t("x") + fetch("//evil")}}')).toBe('{{t("x") + fetch("//evil")}}');
    expect(findUnsafeExpression({ fields: [{ uiSchema: { 'x-component-props': { a: 'ok {{ window.x }}' } } }] })).toBe(
      '{{ window.x }}',
    );
    expect(findUnsafeExpression('{{t("a", { ns: someVar })}}')).toBeTruthy();
    expect(findUnsafeExpression('broken {{ t("a")')).toBe('broken {{ t("a")');
  });
});

describe('findUnsafeExpressionInUi', () => {
  it('only looks at the parts NocoBase UI compiles', () => {
    // A formula field's expression is evaluated by a sandboxed formula engine, not by the UI.
    expect(
      findUnsafeExpressionInUi({
        name: 'total',
        type: 'formula',
        expression: '{{gross_weight}} * {{quantity}}',
        uiSchema: { title: '{{t("Total")}}' },
      }),
    ).toBeUndefined();
    expect(findUnsafeExpressionInUi({ title: '{{ alert(1) }}' })).toBe('{{ alert(1) }}');
    expect(findUnsafeExpressionInUi({ uiSchema: { 'x-component-props': { onClick: '{{ fetch("/x") }}' } } })).toBe(
      '{{ fetch("/x") }}',
    );
    expect(findUnsafeExpressionInUi(undefined)).toBeUndefined();
  });
});

describe('findUnsafeTextsInUi', () => {
  it('lists every affected text in full', () => {
    expect(
      findUnsafeTextsInUi({
        description: 'Total: ({{a}} || 0) + ({{b}} || 0)',
        uiSchema: { title: '{{t("Ok")}}', 'x-component-props': { tip: 'see {{ window.x }}' } },
        expression: '{{a}} + {{b}}',
      }),
    ).toEqual(['Total: ({{a}} || 0) + ({{b}} || 0)', 'see {{ window.x }}']);
  });
});

describe('sqlProblem', () => {
  it('accepts one read-only query', () => {
    expect(sqlProblem('SELECT id, title FROM areas')).toBeUndefined();
    expect(sqlProblem('select * from a join b on a.id = b."aId";')).toBeUndefined();
    expect(sqlProblem('WITH t AS (SELECT id FROM a) SELECT * FROM t')).toBeUndefined();
    expect(sqlProblem('SELECT "updatedAt", "createdById" FROM a')).toBeUndefined();
  });

  it('refuses anything that could write, read server internals or run more than one statement', () => {
    expect(sqlProblem('')).toBe('empty query');
    expect(sqlProblem('DELETE FROM users')).toBe('not a SELECT statement');
    expect(sqlProblem('SELECT 1; DROP TABLE users')).toBe('more than one statement');
    expect(sqlProblem('WITH d AS (DELETE FROM users RETURNING *) SELECT * FROM d')).toBe('uses "delete"');
    expect(sqlProblem('SELECT * INTO copy FROM users')).toBe('uses "into"');
    expect(sqlProblem("SELECT pg_read_file('/etc/passwd')")).toBe('uses "pg_"');
    expect(sqlProblem('SELECT * FROM information_schema.tables')).toBe('uses "information_schema"');
  });
});

describe('sqlProblem: dynamic SQL', () => {
  it('refuses functions that run SQL from a string or leave the database', () => {
    expect(sqlProblem("SELECT query_to_xml('delete from users', true, true, '')")).toBe('uses "query_to_xml"');
    expect(sqlProblem("SELECT * FROM dblink('host=x', 'select 1') AS t(a int)")).toBe('uses "dblink"');
    expect(sqlProblem('SELECT lo_import(1)')).toBe('uses "lo_import"');
    expect(sqlProblem('SELECT hello_world FROM t')).toBeUndefined();
  });
});
