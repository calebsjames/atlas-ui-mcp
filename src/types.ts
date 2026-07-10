/**
 * Architectural layer type for scanned items
 */
export type ArchitectureLayer =
  | "component"
  | "page"
  | "hook"
  | "service"
  | "adapter"
  | "context"
  | "store"
  | "dto"
  | "type"
  /** Plain helper modules (src/utils etc.) — graph nodes so impact through them is traceable */
  | "util"
  /** App entry/root files (src/App.*, src/main.*) — hosts of app-global UI */
  | "root";

/**
 * Configuration file schema (.atlas-ui.json)
 */
export interface ProjectConfig {
  scanTargets?: ScanTarget[];
  routeFiles?: string[];
  aliases?: Record<string, string>;
  exclude?: string[];
  phiCompliance?: {
    enabled?: boolean;
    additionalPatterns?: string[];
  };
  browser?: BrowserConfig;
  /** Tunables for template-layer (overlay/z-index/header) design-drift detection. */
  templatePatterns?: {
    overlayClasses?: string[]; // extra class tokens that mark an overlay/backdrop
    overlayComponents?: string[]; // component-name globs, e.g. "*Overlay", "*Backdrop"
    headerClasses?: string[]; // class tokens that mark a header region
    maxZIndex?: number; // when set, audit flags z-index values above this
  };
}

/**
 * Runtime browser configuration for the "check your work" tools.
 * The MCP assumes the dev server is already running at `devServerUrl`.
 */
export interface BrowserConfig {
  /** Base URL of the running app, e.g. "http://localhost:5173" */
  devServerUrl?: string;
  /** Run the browser headless (default true). Set false to watch it drive. */
  headless?: boolean;
  /** Viewport size for screenshots. */
  viewport?: { width: number; height: number };
  /** Where screenshots/videos are written (relative to workspace root). */
  outputDir?: string;
  /**
   * Default concrete values for dynamic route segments when rendering,
   * e.g. { id: "1", patientId: "demo" }. Per-call params override these.
   */
  routeParams?: Record<string, string>;
  /**
   * Optional login pre-step. When set, the session authenticates ONCE on first
   * use; the resulting session persists across every browser tool call, so
   * protected routes render logged-in. Credentials should come from env vars
   * via `${VAR}` interpolation in action `text` — never hard-code secrets here.
   */
  login?: BrowserLoginConfig;
}

/**
 * Declarative login flow. Structurally a navigation + a list of interactions,
 * with an optional success check so we don't close the page mid-authentication.
 */
export interface BrowserLoginConfig {
  /** Where the login form lives (absolute URL or dev-server-relative path). */
  url: string;
  /** Interactions to authenticate, in order. `text` supports `${ENV_VAR}`. */
  actions: Array<{
    type: "click" | "fill" | "press" | "select" | "check" | "uncheck" | "hover" | "waitFor";
    selector?: string;
    text?: string;
    key?: string;
    timeoutMs?: number;
  }>;
  /** Wait for this selector after the actions to confirm login succeeded. */
  successSelector?: string;
  /** Or confirm the URL changed to include this substring (e.g. "/home"). */
  successUrlIncludes?: string;
}

/**
 * Scan target configuration
 */
export interface ScanTarget {
  dir: string; // Relative to workspace root (e.g., "src/components")
  extensions: string[]; // File extensions to include (e.g., [".tsx"])
  type: ArchitectureLayer;
}

/**
 * Accessibility metadata
 */
export interface AccessibilityInfo {
  ariaAttributes: string[];
  roles: string[];
  semanticElements: string[];
  keyboardHandlers: string[];
  hasTestId: boolean;
  hasScreenReaderSupport: boolean;
}

/**
 * A form control extracted from a component's markup, with the best selector
 * available for driving it in the browser tools (capture_flow / login actions).
 */
export interface FormFieldInfo {
  /** Best selector for this field: #id > [data-testid] > [name] > tag[type]. */
  selector: string;
  /** Element tag: input | select | textarea | button */
  element: string;
  /** `type` attribute for inputs/buttons (text, password, submit, ...). */
  inputType?: string;
  name?: string;
  id?: string;
  testId?: string;
  /** aria-label or placeholder, whichever gives a human hint. */
  label?: string;
}

/**
 * Returned instead of a result when a name matches multiple catalog items and
 * no `file` disambiguator was provided. An honest "which one?" beats a
 * plausible answer about the wrong file.
 */
export interface AmbiguousMatch {
  ambiguous: true;
  message: string;
  candidates: {
    name: string;
    relativePath: string;
    architectureLayer: ArchitectureLayer;
  }[];
}

/**
 * Import information - ENHANCED
 */
export interface ImportInfo {
  type: "named" | "default" | "namespace";
  names: string[]; // Imported names
  source: string; // Original import path
  resolvedPath?: string; // Absolute file path (if resolvable)
}

/**
 * Component metadata structure - ENHANCED
 */
export interface Component {
  name: string;
  path: string;
  category: string;
  relativePath: string;
  lastModified: number;
  architectureLayer: ArchitectureLayer; // Which layer this belongs to
  line?: number;
  exportType?: "named" | "default" | "none";
  description?: string;
  hooks?: string[];
  stateVariables?: string[];
  accessibility?: AccessibilityInfo;

  // Epic 001 enhancements
  childComponents?: string[]; // PascalCase JSX elements rendered
  childComponentLines?: Record<string, number>; // first usage line per child (template/JSX)
  // Children that are NEVER rendered unconditionally, with the governing
  // directive expressions. Absent child = always mounted when the parent is.
  childComponentRendering?: Record<string, RenderConditions>;
  eventHandlers?: string[]; // onClick, onSubmit, etc.
  imports?: ImportInfo[]; // Import statements
  dataFetchingPattern?: string; // "react-query" | "swr" | "useEffect-fetch" | etc.

  // Concrete selectors so agents can drive capture_flow without reading source
  testIds?: string[]; // data-testid attribute values
  testIdLines?: Record<string, number>; // first usage line per data-testid value
  formFields?: FormFieldInfo[]; // form controls with usable selectors

  // Store layer (Pinia / Zustand / Redux Toolkit)
  storeCalls?: string[]; // store hooks referenced (e.g. useCartStore)
  storeName?: string; // Pinia store id / defineStore name, when detected

  // Vue-specific metadata
  emits?: string[]; // DECLARED emitted event names (Vue defineEmits / Options API emits)
  emitsFired?: string[]; // declared emits with a real emit()/$emit() call site (proven live)
  emitsDead?: string[]; // declared but never fired anywhere — dead plumbing
  emitsUndeclared?: string[]; // fired in code/template but not declared (Vue 3 would warn)
  emitsDynamic?: boolean; // emit(variable) or emit fn passed to another module — liveness unprovable
  vModelBindings?: string[]; // v-model bindings (e.g., ["modelValue", "search", "filters"])
  // Events this component binds on each child it renders (@event / v-on:event),
  // per child — feeds dangling-listener detection (parent listens for an event
  // the child never fires).
  childEventBindings?: ChildEventBinding[];
  templatePatterns?: TemplatePatterns; // overlay/teleport/z-index/header design signals
  // Recoverable SFC syntax errors — analysis reflects the parser's recovery,
  // so results for this file may be partial (capped list).
  sfcParseErrors?: Array<{ message: string; line?: number }>;
  styleBlocks?: StyleBlockInfo[]; // <style> blocks: scoped/global, lang, v-bind()

  // Hook-specific metadata
  parameters?: string[]; // Function parameters for hooks
  returnType?: string; // Return type for hooks
  queryKeys?: string[]; // React Query keys used
  adapterCalls?: string[]; // Adapter/service functions called
  // Methods invoked per adapter/service-ish callee, e.g. { userAdapter: ["getUser"] }.
  // Lets data-flow tracing scope an adapter's endpoints to what's actually called.
  methodCalls?: Record<string, string[]>;
  phiCompliance?: PhiComplianceInfo; // PHI compliance status

  // Service/adapter-specific metadata
  apiEndpoints?: string[]; // API endpoints called (file-wide union)
  // apiEndpoints attributed to the enclosing exported function/method, e.g.
  // { getSessions: ["GET /fitting-sessions"] }. Pairs with callers' methodCalls.
  endpointsByMethod?: Record<string, string[]>;
  // Per exported method, the callee.method pairs it delegates to, e.g.
  // { getSessions: { fittingAdapter: ["listSessions"] } } — keeps a trace that
  // enters via one service method from inheriting the whole file's adapter calls.
  delegatesByMethod?: Record<string, Record<string, string[]>>;
  hasMockImplementation?: boolean; // Uses mock/real adapter pattern
  dtosUsed?: string[]; // DTOs referenced

  // Route metadata (for pages)
  routePath?: string; // URL route path
  isProtected?: boolean; // Requires authentication

  // File alias (when defineComponent name differs from filename)
  fileAlias?: string;
}

/**
 * PHI compliance information
 */
export interface PhiComplianceInfo {
  hasZeroCacheTime: boolean; // gcTime: 0
  hasZeroStaleTime: boolean; // staleTime: 0
  hasConsoleLogNearPhi: boolean; // console.log near patient data
  hasLocalStorageUsage: boolean; // localStorage usage
  hasSessionStorageUsage: boolean; // sessionStorage usage
  violations: string[]; // Human-readable violation descriptions
}

/**
 * Route mapping entry
 */
export interface RouteEntry {
  path: string;
  component: string;
  isProtected: boolean;
  /**
   * How `isProtected` was determined:
   * - "route-meta": per-route meta (requiresAuth) in the route definition
   * - "wrapper": a React protection wrapper element (RequireAuth, ...)
   * - "global-guard-prefix": a global beforeEach guard whose path-prefix list was parsed
   * - "unknown": a global beforeEach guard exists but couldn't be statically parsed —
   *   isProtected may under-report and should be treated as unknown
   */
  protection?: "route-meta" | "wrapper" | "global-guard-prefix" | "unknown";
  parentLayout?: string;
  children?: RouteEntry[];
  isDynamic: boolean;
  dynamicSegments?: string[];
}

/**
 * Dead code detection result
 */
export interface DeadCodeEntry {
  name: string;
  relativePath: string;
  architectureLayer: ArchitectureLayer;
  exportType: "named" | "default" | "none";
  reason: string;
}

/**
 * Component catalog organized by category
 */
export interface ComponentCatalog {
  components: Component[];
  categories: Record<string, Component[]>;
  totalCount: number;
  lastScanned: number;
  routes?: RouteEntry[];
}

/**
 * Prop metadata
 */
export interface PropInfo {
  type: string;
  required: boolean;
  description?: string;
  defaultValue?: string;
}

/**
 * Component props result
 */
export interface ComponentProps {
  componentName: string;
  propsInterfaceName?: string;
  props: Record<string, PropInfo>;
  extendsTypes?: string[];
}

/** Events a parent binds on one child component it renders (@event / v-on:event). */
export interface ChildEventBinding {
  component: string; // child component tag (PascalCase as written in the template)
  events: string[]; // event names listened for, modifiers stripped (e.g. "status-updated")
  lines?: Record<string, number>; // first 1-based file line of each event's binding
}

/**
 * The nearest v-if / v-show / v-for governing an element (on itself or an
 * ancestor). Each field is the directive's expression source; a bare v-else
 * records "(else)". Absent field = not governed by that directive kind.
 * Note the semantics differ: v-if gates MOUNTING (component not created),
 * v-show only toggles visibility (still mounted, still fetching).
 */
export interface RenderConditions {
  vIf?: string;
  vShow?: string;
  vFor?: string;
}

/** A modal/overlay/backdrop element detected in a template. */
export interface OverlayPattern {
  tag: string; // element tag (e.g. "div") or component name
  classes: string[]; // matched overlay-ish class tokens
  source: "class" | "utility" | "component"; // how it was recognised
  // The click binding on the overlay, if any. `.self` is the correct
  // backdrop-only-close modifier; a bare @click on a backdrop is a common bug.
  clickHandler?: { bound: true; modifiers: string[]; expression: string };
  viaTeleport?: boolean; // rendered inside a <Teleport>
  // How the overlay is gated: v-show keeps it mounted (and in the a11y tree /
  // stacking context); v-if removes it — a common drift axis for backdrops.
  rendering?: RenderConditions;
  line?: number; // 1-based line in the SFC
}

/** One <style> block of an SFC. Unscoped blocks leak selectors globally. */
export interface StyleBlockInfo {
  line: number; // 1-based line where the block starts
  scoped?: boolean;
  module?: boolean; // <style module> (CSS modules)
  lang?: string; // "scss", "less", … (absent for plain css)
  hasVBind?: boolean; // uses v-bind() in CSS — reactive script/style coupling
}

/** A z-index value found in a <style> block, inline style, or utility class. */
export interface ZIndexRef {
  value: string; // raw value: "9999", "auto", "var(--z-modal)"
  numeric?: number; // parsed integer when the value is a plain number
  where: "style" | "inline" | "utility";
  selector?: string; // best-effort CSS selector (style blocks only)
  line?: number;
}

/** A <Teleport> usage in a template. */
export interface TeleportInfo {
  present: true;
  targets: string[]; // to="..." / :to="..." values
  disabledBinding?: boolean; // has a :disabled binding
  count: number;
}

export interface HeadingInfo {
  level: number; // 1-6
  text?: string;
}

/**
 * Template-layer design signals for a Vue SFC — the "did the overlay/modal
 * markup drift from the design rubric?" surface. All fields omitted when empty.
 */
export interface TemplatePatterns {
  overlays?: OverlayPattern[];
  teleport?: TeleportInfo;
  zIndexes?: ZIndexRef[];
  headings?: HeadingInfo[];
  hasHeaderElement?: boolean; // a <header> element is present
  headerRegions?: string[]; // classes matching header patterns (e.g. "modal-header")
}

/**
 * Component analysis result
 */
export interface ComponentAnalysis {
  line?: number;
  exportType?: "named" | "default" | "none";
  description?: string;
  hooks?: string[];
  stateVariables?: string[];
  accessibility?: AccessibilityInfo;
  childComponents?: string[];
  childComponentLines?: Record<string, number>;
  childComponentRendering?: Record<string, RenderConditions>;
  eventHandlers?: string[];
  imports?: ImportInfo[];
  dataFetchingPattern?: string;
  testIds?: string[];
  testIdLines?: Record<string, number>;
  formFields?: FormFieldInfo[];
  storeCalls?: string[];
  storeName?: string;
  emits?: string[];
  emitsFired?: string[];
  emitsDead?: string[];
  emitsUndeclared?: string[];
  emitsDynamic?: boolean;
  childEventBindings?: ChildEventBinding[];
  templatePatterns?: TemplatePatterns;
  sfcParseErrors?: Array<{ message: string; line?: number }>;
  styleBlocks?: StyleBlockInfo[];
  vModelBindings?: string[];
  parameters?: string[];
  returnType?: string;
  queryKeys?: string[];
  adapterCalls?: string[];
  methodCalls?: Record<string, string[]>;
  phiCompliance?: PhiComplianceInfo;
  apiEndpoints?: string[];
  endpointsByMethod?: Record<string, string[]>;
  delegatesByMethod?: Record<string, Record<string, string[]>>;
  hasMockImplementation?: boolean;
  dtosUsed?: string[];
}

/**
 * Dependency chain node
 */
export interface DependencyNode {
  name: string;
  relativePath: string;
  architectureLayer: ArchitectureLayer;
  dependsOn: DependencyNode[];
  usedBy: DependencyNode[];
}