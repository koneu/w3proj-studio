// The words the workbench uses for a command nobody registered (workbench/commands.ts), shared so
// that a caller can tell an extension that isn't there from a command that failed.

export const commandNotFound = (id: string) => `command not found: ${id}`;
