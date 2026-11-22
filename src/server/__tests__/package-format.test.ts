import { findUnsafeExpression, findUnsafeExpressionInUi } from '../package-format';

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
