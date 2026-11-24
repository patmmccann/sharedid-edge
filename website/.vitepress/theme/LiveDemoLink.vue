<script setup lang="ts">
// The live demo's call to action, placed by config.mts on the home page right under the title, in place of the
// README's plain-Markdown link line.
const DEMO_URL = 'https://e2e.sharedid.dev/demo/';
</script>

<template>
  <div class="live-demo">
    <a class="live-demo-button" :href="DEMO_URL" target="_blank" rel="noopener">▶ See it working live</a>
    <span class="live-demo-text">
      Every deployment this project's tests keep running, with green checks for the cookie the server sets in your
      browser.
    </span>
  </div>
</template>

<style scoped>
.live-demo {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 12px 16px;
  margin: 16px 0 24px;
  padding: 16px 20px;
  border: 1px solid var(--vp-c-brand-soft);
  border-radius: 12px;
  background: var(--vp-c-brand-soft);
}

.live-demo-button {
  display: inline-block;
  padding: 10px 20px;
  border-radius: 20px;
  background: var(--vp-c-brand-1);
  color: var(--vp-c-white);
  font-weight: 600;
  text-decoration: none;
  white-space: nowrap;
}

.live-demo-button:hover {
  background: var(--vp-c-brand-2);
}

.live-demo-text {
  flex: 1 1 260px;
  color: var(--vp-c-text-1);
}
</style>
