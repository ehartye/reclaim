import { defineConfig } from "vite";
export default defineConfig({
  build: {
    rolldownOptions: {
      onwarn(warning, defaultHandler) {
        // This is a client-only application; React Server Component directives in icons have no role.
        if (
          warning.code === "MODULE_LEVEL_DIRECTIVE" &&
          warning.message.includes("use client") &&
          warning.message.includes("lucide-react")
        )
          return;
        defaultHandler(warning);
      },
    },
  },
});
