// VitePress's default theme, plus the SharedID adoption chart, registered globally: config.mts places it on the home
// page (the root README) between the introduction and "How it works", so the README stays plain Markdown.
import DefaultTheme from 'vitepress/theme';
import type { Theme } from 'vitepress';
import AdoptionChart from './AdoptionChart.vue';

const theme: Theme = {
  extends: DefaultTheme,
  enhanceApp({ app }) {
    app.component('AdoptionChart', AdoptionChart);
  }
};

export default theme;
