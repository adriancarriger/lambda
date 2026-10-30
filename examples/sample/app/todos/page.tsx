"use client";

import { useState } from "react";

interface Todo {
  id: number;
  text: string;
  completed: boolean;
}

export default function TodosPage() {
  const [todos, setTodos] = useState<Todo[]>([]);
  const [input, setInput] = useState("");

  const addTodo = () => {
    const trimmed = input.trim();
    if (!trimmed) return;
    setTodos((prev) => [
      ...prev,
      { id: Date.now(), text: trimmed, completed: false },
    ]);
    setInput("");
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") addTodo();
  };

  return (
    <main className="max-w-md mx-auto mt-16 p-6">
      <h1 className="text-2xl font-bold mb-6">Todos</h1>

      <div className="flex gap-2 mb-6">
        <input
          data-testid="todo-input"
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="What needs to be done?"
          className="flex-1 px-3 py-2 border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
        <button
          data-testid="add-todo"
          onClick={addTodo}
          className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 transition"
        >
          Add
        </button>
      </div>

      {todos.length === 0 ? (
        <p data-testid="empty-state" className="text-gray-400 text-center py-8">
          No todos yet. Add one above!
        </p>
      ) : (
        <ul data-testid="todo-list" className="space-y-2">
          {todos.map((todo) => (
            <li
              key={todo.id}
              data-testid="todo-item"
              className="flex items-center gap-3 p-3 bg-white rounded shadow-sm"
            >
              <span data-testid="todo-text">{todo.text}</span>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
