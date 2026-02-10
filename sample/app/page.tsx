import Link from "next/link";

export default function Home() {
  return (
    <main className="flex flex-col items-center justify-center min-h-screen p-8">
      <h1 className="text-4xl font-bold mb-4">Lambda Sample App</h1>
      <p className="text-gray-600 mb-8">
        A simple todo app for testing multi-agent development.
      </p>
      <Link
        href="/todos"
        className="px-6 py-3 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition"
      >
        Go to Todos
      </Link>
    </main>
  );
}
