import { defineConfig } from '@playwright/test';
import config from './playwright.config.mjs';

export default defineConfig({
  ...config,
  testMatch: '**/*.pages.mjs',
  outputDir: './.cache/playwright-pages',
  projects: config.projects.filter(project => project.name === 'desktop'),
});
