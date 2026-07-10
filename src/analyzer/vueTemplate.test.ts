import { test } from "node:test";
import assert from "node:assert/strict";
import {
  extractVueScript,
  extractTemplateBlock,
  analyzeVueTemplate,
  extractChildEventBindings,
  extractDynamicComponentBindings,
  extractVueTemplateSelectors,
} from "./vueTemplate.js";
import { analyzeVueTemplatePatterns } from "./templatePatterns.js";
import { scriptAbsoluteLine } from "./sfcParser.js";

/**
 * Pins the behaviors the @vue/compiler-sfc migration fixed. Each case is a
 * minimized reproduction of a defect the regex scanners exhibited on the
 * foreward-ui corpus (264 real SFCs) — see the failure noted above each test.
 */

const sfc = (template: string, script = "") =>
  `<template>\n${template}\n</template>\n<script setup lang="ts">\n${script}\n</script>\n`;

// Regex truncated at the hyphen: @customer-updated was recorded as "customer".
test("kebab-case event names survive whole", () => {
  const { eventHandlers } = analyzeVueTemplate(
    sfc(`<OrderCard @contact-builder="onContact" @update:model-value="onUpdate" />`)
  );
  assert.deepEqual(eventHandlers, ["contact-builder", "update:model-value"]);
});

test("event modifiers keep the regex-era shape", () => {
  const { eventHandlers } = analyzeVueTemplate(
    sfc(`<div @click.self.prevent="close" />`)
  );
  assert.deepEqual(eventHandlers, ["click.self.prevent"]);
});

// extractChildEventBindings truncated at the colon: @update:model-value → "update",
// which could never match a child's declared "update:modelValue".
test("child event bindings record full names, modifiers stripped", () => {
  const bindings = extractChildEventBindings(
    sfc(`<FormSelect @update:model-value="x" @select.once="y" />`)
  );
  assert.deepEqual(bindings, [
    { component: "FormSelect", events: ["select", "update:model-value"] },
  ]);
});

// Commented-out markup produced phantom children, bindings, and form fields
// (AssistantPanel's <Bell />, BuilderProfile's <component :is="RefreshCw">).
test("commented-out markup is not analyzed", () => {
  const src = sfc(`
    <div>
      <!-- <Bell class="w-4" /> -->
      <!-- <button aria-label="Refresh stations" @click="refresh">
        <component :is="RefreshCw" />
      </button> -->
      <RealChild @real-event="x" />
    </div>`);
  const { childComponents, eventHandlers } = analyzeVueTemplate(src);
  assert.deepEqual(childComponents, ["RealChild"]);
  assert.deepEqual(eventHandlers, ["real-event"]);
  assert.deepEqual(extractDynamicComponentBindings(src), []);
  assert.deepEqual(extractVueTemplateSelectors(src).formFields, []);
});

// Prettier splits closing tags across lines (`</template\n>`); the regex depth
// tracker missed them and fell back to "rest of the file".
test("split closing tags do not break template extraction", () => {
  const src = `<template>
  <div>
    {{ city }}<template v-if="state">, </template
    ><span>{{ state }}</span>
  </div>
</template>
<script setup>
const irrelevant = 1;
</script>
`;
  const block = extractTemplateBlock(src);
  assert.ok(block !== undefined);
  assert.ok(!block.includes("irrelevant"), "template block must not swallow the script");
});

// `[A-Z][A-Za-z0-9]+` needs two characters: lucide's <X /> was invisible.
test("single-letter components are found", () => {
  const { childComponents } = analyzeVueTemplate(sfc(`<button><X class="w-4" /></button>`));
  assert.deepEqual(childComponents, ["X"]);
});

// Kebab-case usage resolves to the registered PascalCase name; builtins are
// excluded whichever casing the template uses.
test("kebab-case components normalize; builtins are excluded", () => {
  const { childComponents } = analyzeVueTemplate(
    sfc(`
      <router-view />
      <transition name="fade"><my-widget /></transition>
      <Teleport to="body"><KeepAlive><TabPane /></KeepAlive></Teleport>`)
  );
  assert.deepEqual(childComponents, ["MyWidget", "RouterView", "TabPane"]);
});

// `@` in placeholder text minted phantom handlers ("example.com") in 9 files.
test("email addresses in attributes are not event handlers", () => {
  const { eventHandlers } = analyzeVueTemplate(
    sfc(`<input placeholder="name@example.com" @focus="onFocus" />`)
  );
  assert.deepEqual(eventHandlers, ["focus"]);
});

test("dynamic component bindings collapse whitespace and keep source order", () => {
  const bindings = extractDynamicComponentBindings(
    sfc(`
      <component :is="tabComponent" />
      <component
        :is="
          active ? Play : Eye
        "
      />`)
  );
  assert.deepEqual(bindings, ["tabComponent", "active ? Play : Eye"]);
});

test("selectors: static attributes only, dynamic bindings skipped", () => {
  const { testIds, formFields } = extractVueTemplateSelectors(
    sfc(`
      <div data-testid="panel">
        <input type="email" name="email" aria-label="Email" />
        <input :id="dynamicId" placeholder="Search" />
        <MyField data-testid="wrapped" />
      </div>`)
  );
  assert.deepEqual(testIds, ["panel", "wrapped"]);
  assert.deepEqual(formFields.map((f) => f.selector), ['[name="email"]', "input"]);
  assert.equal(formFields[0].label, "Email");
});

// The old regex took the first <script> block only; both blocks are legal.
test("dual <script> + <script setup> both contribute", () => {
  const src = `<template><div /></template>
<script>
export const fromPlain = 1;
</script>
<script setup>
const fromSetup = 2;
</script>
`;
  const script = extractVueScript(src);
  assert.ok(script.includes("fromPlain") && script.includes("fromSetup"));
});

// Declaration lines were relative to the <script> block, not the file.
test("script lines map back to absolute file lines", () => {
  const src = `<template>\n  <div />\n  <div />\n</template>\n<script setup>\nconst target = 1;\n</script>\n`;
  // "const target" is content line 2 of the script block, file line 6.
  assert.equal(scriptAbsoluteLine(src, 2), 6);
});

// -- templatePatterns ---------------------------------------------------------

// Nested <template #slot> truncated the old scan at the first </template>,
// hiding Teleports, headings, and overlays declared after it.
test("patterns past a nested <template #slot> are seen", () => {
  const patterns = analyzeVueTemplatePatterns(
    sfc(`
      <BaseCard>
        <template #header><h2>Title</h2></template>
        <template #body>
          <Teleport to="body">
            <div class="fixed inset-0 bg-black/50" @click.self="close" />
          </Teleport>
          <h4>This will:</h4>
        </template>
      </BaseCard>`)
  );
  assert.equal(patterns?.teleport?.count, 1);
  assert.deepEqual(patterns?.teleport?.targets, ["body"]);
  assert.deepEqual(patterns?.headings?.map((h) => h.text), ["Title", "This will:"]);
  const overlay = patterns?.overlays?.[0];
  assert.equal(overlay?.source, "utility");
  assert.equal(overlay?.viaTeleport, true);
  assert.deepEqual(overlay?.clickHandler?.modifiers, ["self"]);
});

// `\bz-(…)\b` could not match z-[100]: `]` to space is no word boundary.
test("arbitrary-value z-index utilities are found", () => {
  const patterns = analyzeVueTemplatePatterns(
    sfc(`<div class="fixed top-0 z-[100]" />`)
  );
  assert.deepEqual(patterns?.zIndexes?.map((z) => z.value), ["100"]);
});

// Multi-class string literals inside :class arrays carry overlay classes
// (the NewCustomer pattern); identifiers like `overlayClasses` are signals
// too (the BaseModal pattern) — but words in JS comments are not (Sidebar).
test(":class expressions: string tokens and identifiers count, comment prose does not", () => {
  const withString = analyzeVueTemplatePatterns(
    sfc(`<div :class="['fixed inset-0 backdrop-blur-sm', zClass]" />`)
  );
  assert.equal(withString?.overlays?.[0].source, "class");

  const withIdentifier = analyzeVueTemplatePatterns(
    sfc(`<div :class="[overlayClasses]" @click.self="onBackdrop" />`)
  );
  assert.equal(withIdentifier?.overlays?.[0].source, "class");

  const withComment = analyzeVueTemplatePatterns(
    sfc(`<aside :class="[
      // position below mobile header (and banner)
      'fixed left-0 w-64',
    ]" />`)
  );
  assert.equal(withComment?.headerRegions, undefined);
});

test("z-index from <style> blocks keeps absolute lines and selectors", () => {
  const src = `<template>\n  <div class="modal" />\n</template>\n<style scoped>\n.modal {\n  z-index: 999;\n}\n</style>\n`;
  const patterns = analyzeVueTemplatePatterns(src);
  assert.deepEqual(patterns?.zIndexes, [
    { value: "999", where: "style", line: 6, numeric: 999, selector: ".modal" },
  ]);
});
