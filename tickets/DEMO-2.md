# Add Completed Checkbox with Strikethrough Styling

## Context

Todo items currently display as plain text. Users need to mark items as completed with a visual indicator.

## Requirements

1. Add a checkbox to the left of each todo item
2. Clicking the checkbox toggles the item's completed state
3. Completed items should have strikethrough text styling
4. Completed items should have reduced opacity (e.g., 0.6)
5. The checkbox should reflect the current completed state

## Acceptance Criteria

- [ ] Each todo item has a checkbox
- [ ] Clicking toggles completed state
- [ ] Completed items show strikethrough text
- [ ] Completed items have reduced opacity
- [ ] State persists correctly when toggling back and forth

## Test IDs

- `data-testid="todo-checkbox"` - The checkbox on each item
- `data-testid="todo-text"` - The text content of each item
- `data-testid="todo-item"` - The item row (should have `data-completed="true"` when done)

## Files to Modify

- `sample/app/todos/page.tsx` - Add checkbox and styling

## Testing

Run `lambda e2e todos.spec.ts` to validate.
