import { test } from "node:test";
import assert from "node:assert/strict";
import { extractReactViewContainer } from "./reactViewContainer.js";

/**
 * The React extractor is the framework-sibling of the Vue one: it recognises a
 * section shell from React constructs (useState + `state === 'lit'` gating JSX +
 * `onClick={() => setState('lit')}`), scoped to state variables so unrelated
 * equality (a prop/role check) can't masquerade as a view switch.
 */

const byId = <T extends { id: string }>(sections: T[], id: string): T => sections.find((s) => s.id === id)!;

test("&&-gated shell: sections, children, and testid/label activators", () => {
  const vc = extractReactViewContainer(
    `import { useState } from 'react';
    export function HomeShell() {
      const [tab, setTab] = useState('prescriptions');
      return (
        <div>
          <nav>
            <button data-testid="tab-rx" onClick={() => setTab('prescriptions')}>Prescriptions</button>
            <button data-testid="tab-bs" onClick={() => setTab('build-sheets')}>Build Sheets</button>
          </nav>
          {tab === 'prescriptions' && <PrescriptionsList />}
          {tab === 'build-sheets' && <BuildSheetsList />}
        </div>
      );
    }`,
    "HomeShell"
  )!;

  assert.equal(vc.container, "HomeShell");
  assert.equal(vc.framework, "react");
  assert.equal(vc.selector, "tab");
  assert.equal(vc.sections.length, 2);

  const rx = byId(vc.sections, "prescriptions");
  assert.equal(rx.child, "PrescriptionsList");
  assert.equal(rx.reachedBy, "click");
  assert.deepEqual(rx.activator, { selector: '[data-testid="tab-rx"]', label: "Prescriptions" });
  assert.equal(byId(vc.sections, "build-sheets").activator?.selector, '[data-testid="tab-bs"]');
});

test("ternary chain yields one section per literal branch", () => {
  const vc = extractReactViewContainer(
    `import { useState } from 'react';
    function Tabs() {
      const [view, setView] = useState('a');
      return view === 'a' ? <A/> : view === 'b' ? <B/> : <Fallback/>;
    }`,
    "Tabs"
  )!;
  assert.equal(vc.selector, "view");
  assert.deepEqual(vc.sections.map((s) => s.id), ["a", "b"]);
  assert.equal(byId(vc.sections, "a").child, "A");
  assert.equal(byId(vc.sections, "b").child, "B");
  assert.equal(byId(vc.sections, "a").reachedBy, "unknown");
});

test("reversed equality ('lit' === state) is recognised", () => {
  const vc = extractReactViewContainer(
    `import { useState } from 'react';
    function T() {
      const [tab, setTab] = useState('x');
      return <>{'x' === tab && <X/>}{'y' === tab && <Y/>}</>;
    }`,
    "T"
  )!;
  assert.equal(vc.selector, "tab");
  assert.deepEqual(vc.sections.map((s) => s.id).sort(), ["x", "y"]);
});

test("equality on a non-state variable is not a view switch", () => {
  // `role` is a prop, not useState — its two gates must NOT form a container,
  // and `tab`'s single gate is below the multiplex threshold.
  const vc = extractReactViewContainer(
    `import { useState } from 'react';
    function Guarded({ role }) {
      const [tab, setTab] = useState('only');
      return (
        <>
          {role === 'admin' && <Admin/>}
          {role === 'user' && <User/>}
          {tab === 'only' && <Only/>}
        </>
      );
    }`,
    "Guarded"
  );
  assert.equal(vc, null);
});

test("returns null without useState or without a multiplex", () => {
  assert.equal(
    extractReactViewContainer(`function P({ tab }) { return tab === 'a' ? <A/> : <B/>; }`, "P"),
    null
  );
});
