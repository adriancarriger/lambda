# Add Delete Button to Each Todo Item

## Context

The todo app currently shows a list of items but has no way to remove them. Users need a delete button on each item.

## Requirements

1. Add a delete button (X or trash icon) to the right side of each todo item
2. Clicking the button removes the item from the list
3. The button should be visually subtle (appears on hover or always visible but muted)
4. Deletion should be immediate (no confirmation dialog needed)

## Acceptance Criteria

- [ ] Each todo item displays a delete button
- [ ] Clicking delete removes the item from the list
- [ ] The list re-renders correctly after deletion
- [ ] Empty state is handled if all items are deleted

## Test IDs

- `data-testid="todo-item"` - Each todo item row
- `data-testid="delete-button"` - The delete button on each item
- `data-testid="todo-list"` - The todo list container
- `data-testid="empty-state"` - Shown when no items remain

## Files to Modify

- `sample/app/todos/page.tsx` - Add delete button and handler

## Testing

Run `lambda e2e todos.spec.ts` to validate.
