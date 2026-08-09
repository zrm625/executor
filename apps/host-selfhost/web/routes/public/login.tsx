import { createFileRoute } from "@tanstack/react-router";

// The root auth gate renders the actual setup or login surface. This explicit
// leaf makes a document navigation and an OAuth return to /login a recognized
// TanStack location instead of falling through to the root 404 component.
export const Route = createFileRoute("/login")({ component: LoginLeaf });

function LoginLeaf() {
  return null;
}
