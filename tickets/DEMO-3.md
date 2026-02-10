# Add Filter Bar (All / Active / Completed)

## Context

After implementing checkboxes (DEMO-2), users need a way to filter the todo list by status. This depends on DEMO-2 being completed first.

## Requirements

1. Add a filter bar below the todo input with three options: All, Active, Completed
2. "All" shows all items (default)
3. "Active" shows only uncompleted items
4. "Completed" shows only completed items
5. The active filter should be visually highlighted
6. Display a count of remaining active items (e.g., "3 items left")

## Acceptance Criteria

- [ ] Filter bar renders with All / Active / Completed buttons
- [ ] "All" is selected by default
- [ ] Clicking "Active" shows only uncompleted items
- [ ] Clicking "Completed" shows only completed items
- [ ] Active filter button is visually distinct
- [ ] Item count displays correctly and updates on changes

## Test IDs

- `data-testid="filter-bar"` - The filter bar container
- `data-testid="filter-all"` - All filter button
- `data-testid="filter-active"` - Active filter button
- `data-testid="filter-completed"` - Completed filter button
- `data-testid="item-count"` - Remaining items count display

## Files to Modify

- `sample/app/todos/page.tsx` - Add filter bar and filtering logic

## Testing

Run `lambda e2e todos.spec.ts` to validate.
