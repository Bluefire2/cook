import { defineConfig } from 'vitest/config';

// Nothing under test touches the DOM, so the node environment keeps runs fast.
export default defineConfig({
  test: {
    environment: 'node',
  },
});
