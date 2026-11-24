// VitePress's default theme, plus the SharedID adoption chart and the live demo's call to action, registered
// globally: config.mts places them on the home page (the root README), so the README stays plain Markdown.
import DefaultTheme from 'vitepress/theme';
import type { Theme } from 'vitepress';
import AdoptionChart from './AdoptionChart.vue';
import LiveDemoLink from './LiveDemoLink.vue';

const theme: Theme = {
  extends: DefaultTheme,
  enhanceApp({ app }) {
    app.component('AdoptionChart', AdoptionChart);
    app.component('LiveDemoLink', LiveDemoLink);
  }
};

export default theme;
