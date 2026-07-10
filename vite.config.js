import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// IMPORTANT for GitHub Pages:
// If your site is published as a PROJECT page — https://<user>.github.io/<repo-name>/ —
// `base` must be set to '/<repo-name>/' (with leading and trailing slash), otherwise the
// built app will look for its JS/CSS at the domain root and you'll get a blank white page.
//
// If your site is instead published as a USER/ORG page — https://<user>.github.io/ (the repo
// itself is literally named "<user>.github.io") — set base back to '/'.
export default defineConfig({
  plugins: [react()],
  base: '/Finanza-Ynab/',
});
