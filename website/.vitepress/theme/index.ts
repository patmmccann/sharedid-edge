// VitePress's default theme, plus the SharedID adoption chart at the top of the home page (the root README), added
// through a layout slot so the README itself stays plain Markdown for GitHub and npm.
import { h } from 'vue';
import { useData } from 'vitepress';
import DefaultTheme from 'vitepress/theme';
import type { Theme } from 'vitepress';
import AdoptionChart from './AdoptionChart.vue';

const theme: Theme = {
  extends: DefaultTheme,
  Layout() {
    const { page } = useData();
    return h(DefaultTheme.Layout, null, {
      'doc-before': () => (page.value.relativePath === 'index.md' ? h(AdoptionChart) : null)
    });
  }
};

export default theme;
