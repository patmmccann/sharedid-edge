<script setup lang="ts">
// SharedID's share of Prebid.js User ID module detections, as a pie, from OpenSincera (adoption.data.ts). One hue for
// SharedID, gray for the rest; the share is also printed large, so it reads without the pie.
import { computed, ref } from 'vue';
import { data } from './adoption.data';

const share = computed(() => data.sharedIdSystem / data.userId);
const percent = computed(() => Math.round(share.value * 100));
const others = computed(() => data.userId - data.sharedIdSystem);
const format = (n: number): string => n.toLocaleString('en-US');
const date = computed(() => new Date(`${data.date}T00:00:00Z`).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' }));

// A slice from 12 o'clock, clockwise, for a fraction of the circle.
const R = 150;
const C = 160;
function point(fraction: number): string {
  const angle = fraction * 2 * Math.PI - Math.PI / 2;
  return `${(C + R * Math.cos(angle)).toFixed(2)} ${(C + R * Math.sin(angle)).toFixed(2)}`;
}
function slice(from: number, to: number): string {
  const large = to - from > 0.5 ? 1 : 0;
  return `M ${String(C)} ${String(C)} L ${point(from)} A ${String(R)} ${String(R)} 0 ${String(large)} 1 ${point(to)} Z`;
}
const sharedPath = computed(() => slice(0, share.value));
const otherPath = computed(() => slice(share.value, 1));

const hovered = ref<'shared' | 'other' | null>(null);
const showTable = ref(false);
</script>

<template>
  <figure class="adoption vp-raw" aria-labelledby="adoption-title">
    <h2 id="adoption-title" class="adoption-title">SharedID across Prebid.js</h2>
    <p class="adoption-lede">Of the Prebid.js sites running the User ID module, the share that also run SharedID.</p>
    <div class="adoption-body">
      <svg
        class="adoption-pie"
        viewBox="0 0 320 320"
        role="img"
        :aria-label="`Pie chart: SharedID runs on ${percent}% of Prebid.js User ID module detections (${format(data.sharedIdSystem)} of ${format(data.userId)}).`"
      >
        <path
          class="slice slice-other"
          :class="{ dim: hovered === 'shared' }"
          :d="otherPath"
          tabindex="0"
          @mouseenter="hovered = 'other'"
          @mouseleave="hovered = null"
          @focus="hovered = 'other'"
          @blur="hovered = null"
        >
          <title>Other User ID setups: {{ format(others) }} detections ({{ 100 - percent }}%)</title>
        </path>
        <path
          class="slice slice-shared"
          :class="{ dim: hovered === 'other' }"
          :d="sharedPath"
          tabindex="0"
          @mouseenter="hovered = 'shared'"
          @mouseleave="hovered = null"
          @focus="hovered = 'shared'"
          @blur="hovered = null"
        >
          <title>SharedID: {{ format(data.sharedIdSystem) }} detections ({{ percent }}%)</title>
        </path>
      </svg>
      <div class="adoption-figures">
        <p class="adoption-hero"><span class="adoption-number">{{ percent }}%</span> run SharedID</p>
        <ul class="adoption-legend">
          <li :class="{ active: hovered === 'shared' }">
            <span class="swatch swatch-shared" aria-hidden="true"></span>
            <span class="legend-name">SharedID (<code>sharedIdSystem</code>)</span>
            <span class="legend-value">{{ format(data.sharedIdSystem) }}</span>
          </li>
          <li :class="{ active: hovered === 'other' }">
            <span class="swatch swatch-other" aria-hidden="true"></span>
            <span class="legend-name">Other User ID setups</span>
            <span class="legend-value">{{ format(others) }}</span>
          </li>
          <li class="legend-total">
            <span class="swatch" aria-hidden="true"></span>
            <span class="legend-name">All User ID module (<code>userId</code>)</span>
            <span class="legend-value">{{ format(data.userId) }}</span>
          </li>
        </ul>
        <button type="button" class="adoption-toggle" :aria-expanded="showTable" @click="showTable = !showTable">
          {{ showTable ? 'Hide' : 'Show' }} the numbers as a table
        </button>
        <table v-if="showTable" class="adoption-table">
          <thead><tr><th scope="col">Prebid.js module</th><th scope="col">Detections</th><th scope="col">Share</th></tr></thead>
          <tbody>
            <tr><td><code>sharedIdSystem</code></td><td>{{ format(data.sharedIdSystem) }}</td><td>{{ percent }}%</td></tr>
            <tr><td>Other <code>userId</code> setups</td><td>{{ format(others) }}</td><td>{{ 100 - percent }}%</td></tr>
            <tr><td><code>userId</code> (all)</td><td>{{ format(data.userId) }}</td><td>100%</td></tr>
          </tbody>
        </table>
      </div>
    </div>
    <figcaption class="adoption-caption">
      Data:
      <a href="https://open.sincera.io" target="_blank" rel="noopener">OpenSincera</a>
      by Sincera, part of The Trade Desk: detections of each Prebid.js module over the 90 days before {{ date }}
      (<a href="https://open.thetradedesk.com/seller/docsApp/GuidesSeller/opensincera/doc/OpenSinceraQueries" target="_blank" rel="noopener"><code>mapping_modules</code></a>).
      Thanks to Sincera for the open data.
    </figcaption>
  </figure>
</template>

<style scoped>
.adoption {
  --series-1: #2a78d6;
  --context: #c3c2b7;
  --surface: var(--vp-c-bg);
  margin: 0 0 48px;
  padding: 28px 28px 20px;
  border: 1px solid var(--vp-c-divider);
  border-radius: 12px;
  background: var(--vp-c-bg);
}
.adoption-title {
  margin: 0;
  padding: 0;
  border: 0;
  font-size: 24px;
  line-height: 32px;
}
.adoption-lede {
  margin: 4px 0 20px;
  color: var(--vp-c-text-2);
}
.adoption-body {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 32px;
}
.adoption-pie {
  flex: 0 1 280px;
  width: 100%;
  max-width: 300px;
  height: auto;
}
.slice {
  stroke: var(--surface);
  stroke-width: 2px;
  stroke-linejoin: round;
  transition: opacity 0.15s;
  outline: none;
  cursor: default;
}
.slice-shared { fill: var(--series-1); }
.slice-other { fill: var(--context); }
.slice.dim { opacity: 0.45; }
.slice:focus-visible { stroke: var(--vp-c-text-1); }
.adoption-figures {
  flex: 1 1 220px;
}
.adoption-hero {
  margin: 0 0 16px;
  color: var(--vp-c-text-2);
  font-size: 18px;
}
.adoption-number {
  display: block;
  color: var(--vp-c-text-1);
  font-size: 64px;
  font-weight: 700;
  line-height: 1.05;
  font-variant-numeric: tabular-nums;
}
.adoption-legend {
  margin: 0;
  padding: 0;
  list-style: none;
}
.adoption-legend li {
  display: flex;
  align-items: center;
  gap: 10px;
  margin: 0;
  padding: 6px 0;
  border-bottom: 1px solid var(--vp-c-divider);
}
.adoption-legend li.active .legend-name { color: var(--vp-c-text-1); font-weight: 600; }
.legend-total { color: var(--vp-c-text-2); }
.swatch {
  flex: none;
  width: 12px;
  height: 12px;
  border-radius: 3px;
}
.swatch-shared { background: var(--series-1); }
.swatch-other { background: var(--context); }
.legend-name { flex: 1; color: var(--vp-c-text-2); }
.legend-value { color: var(--vp-c-text-1); font-variant-numeric: tabular-nums; }
.adoption-toggle {
  margin-top: 12px;
  padding: 0;
  border: 0;
  background: none;
  color: var(--vp-c-brand-1);
  font-size: 14px;
  cursor: pointer;
}
.adoption-table { margin-top: 8px; font-size: 14px; }
.adoption-caption {
  margin-top: 20px;
  color: var(--vp-c-text-2);
  font-size: 13px;
  line-height: 20px;
}
</style>

<style>
/* The dark-mode steps of the same two colors (validated against the dark surface), on VitePress's .dark root class. */
.dark .adoption {
  --series-1: #3987e5;
  --context: #52514e;
}
</style>
