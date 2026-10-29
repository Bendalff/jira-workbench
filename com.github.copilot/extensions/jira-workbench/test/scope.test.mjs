import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_SCOPE, scopeJql, validateScope, workingSetKey, mergeIssues } from "../lib/scope.mjs";
import { workingSetSummary, childLoadState } from "../lib/view-model.mjs";
import { buildTree, normalizeIssue } from "../lib/model.mjs";
import { Workbench } from "../lib/workbench.mjs";

const row = (id, extra = {}) => ({ id, key: `DEMO-${id}`, projectId: "42", summary: `Work ${id}`, level: 0, status: "To Do", category: "new", dependencies: [], labels: [], ...extra });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

function fixture() {
    let data = { mappings: {}, links: {}, requests: {}, preferences: {} };
    const store = { read: async () => structuredClone(data), update: async change => { const next = structuredClone(data); change(next); data = next; } };
    const gateway = {
        issues: async () => ({ issues: [row("1")], nextPageToken: "second", fetchedAt: "2026-01-01T00:00:00Z" }),
        ancestors: async () => ({ issues: [row("10", { key: "PARENT-10", projectId: "43", level: 1, type: "Feature", contextOnly: true })], warnings: [] }),
        children: async () => ({ issues: [row("3", { parentKey: "DEMO-1" })], nextPageToken: "more-children" }),
    };
    const wb = new Workbench({ store, gateway });
    wb.site = { id: "demo-site", name: "Example", url: "https://example.atlassian.net" };
    wb.project = { id: "42", key: "DEMO", name: "Example project" };
    return { wb, gateway, store };
}

test("scope builds project-constrained server JQL without corrupting quoted ORDER BY", () => {
    assert.equal(scopeJql("42"), "project = 42 ORDER BY key ASC");
    assert.equal(scopeJql("42", { kind: "filter", value: "123" }), "project = 42 AND (filter = 123) ORDER BY key ASC");
    assert.equal(scopeJql("42", { kind: "jql", value: 'text ~ "ORDER BY" ORDER BY updated DESC, key ASC' }), 'project = 42 AND (text ~ "ORDER BY") ORDER BY updated DESC, key ASC');
    assert.equal(scopeJql("42", { kind: "jql", value: "status = Open OR status = Closed" }), "project = 42 AND (status = Open OR status = Closed) ORDER BY key ASC");
    assert.throws(() => scopeJql("42 OR project = 43"), /numeric/);
    assert.throws(() => scopeJql("42", { kind: "jql", value: "status = Open) OR project = 43 OR (status = Closed" }), /unmatched/);
    assert.throws(() => scopeJql("42", { kind: "jql", value: 'summary ~ "unclosed' }), /unclosed/);
    assert.throws(() => validateScope({ kind: "filter", value: "123 OR 1=1" }), /numeric/);
    assert.throws(() => validateScope({ kind: "jql", value: "" }), /expression/);
    assert.throws(() => validateScope({ kind: "jql", value: "x".repeat(4001) }), /4,000/);
    assert.notEqual(workingSetKey("site/42/project", DEFAULT_SCOPE), workingSetKey("site/42/project", { kind: "filter", value: "123" }));
});

test("scope is explicitly applied, durable and separate from project trace/mapping identities", async () => {
    const { wb, store } = fixture();
    const projectScope = wb.selectedScope();
    await wb.setScope({ kind: "filter", value: "123" });
    assert.deepEqual(wb.workingScope, DEFAULT_SCOPE);
    assert.equal(wb.issues.length, 0);
    await wb.applyScope();
    assert.equal(wb.workingScope.value, "123");
    assert.equal(wb.selectedScope(), projectScope);
    assert.equal((await store.read()).preferences[projectScope].workingScope.value, "123");
    const reopened = new Workbench({ store, gateway: wb.gateway });
    reopened.site = wb.site; reopened.project = wb.project;
    await reopened.restoreScope();
    assert.deepEqual(reopened.workingScope, wb.workingScope);
});

test("a failed scope save keeps the prior working set and reports the persistence failure", async () => {
    const { wb, store } = fixture();
    await wb.refresh();
    store.update = async () => { throw new Error("Disk is full"); };
    await assert.rejects(wb.applyScope({ kind: "filter", value: "123" }), /Disk is full/);
    assert.deepEqual(wb.workingScope, DEFAULT_SCOPE);
    assert.equal(wb.issues[0].id, "1");
    assert.equal(wb.jiraRefreshing, null);
});

test("scope-aware warm caches never mix pages and scope changes preserve durable artifacts", async () => {
    const { wb, store } = fixture();
    let cached = { issues: {} };
    wb.cache = {
        read: async () => structuredClone(cached),
        update: async change => { change(cached); },
    };
    await store.update(data => {
        data.mappings[wb.selectedScope()] = { id: "repo", repo: "example/demo" };
        data.links[wb.selectedScope("1")] = { sessions: [{ id: "session" }], prs: [] };
        data.requests.queued = { scope: wb.selectedScope("1"), nodeId: "1", status: "queued" };
    });
    const durable = await store.read();
    await wb.refresh();
    const projectKey = wb.loadKey();
    await wb.applyScope({ kind: "filter", value: "123" });
    assert.notEqual(wb.loadKey(), projectKey);
    assert.equal(Object.keys(cached.issues).length, 2);
    const saved = await store.read();
    assert.deepEqual(saved.mappings, durable.mappings);
    assert.deepEqual(saved.links, durable.links);
    assert.deepEqual(saved.requests, durable.requests);
    cached.catalog = { sites: [wb.site], appProjects: [] };
    cached.projectLists = { [wb.site.id]: { projects: [wb.project] } };
    const reopened = new Workbench({ store, cache: wb.cache });
    assert.equal(await reopened.hydrate(), true);
    assert.equal(reopened.workingScope.value, "123");
    assert.equal(reopened.page.nextPageToken, "second");
    assert.equal(reopened.cached, true);
});

test("late scope, refresh and child responses cannot mix working sets, including A-B-A switches", async () => {
    const { wb, gateway } = fixture();
    const old = deferred(), entered = deferred();
    gateway.issues = async (site, project, options) => {
        if (options.scope.value === "old") { entered.resolve(); return old.promise; }
        return { issues: [row("2")], fetchedAt: "new" };
    };
    const pending = wb.applyScope({ kind: "jql", value: "old" });
    await entered.promise;
    await wb.applyScope({ kind: "jql", value: "new" });
    old.resolve({ issues: [row("1")], nextPageToken: "old-cursor", fetchedAt: "old" });
    await pending;
    assert.deepEqual(wb.issues.filter(issue => !issue.contextOnly).map(issue => issue.id), ["2"]);
    assert.equal(wb.page.nextPageToken, null);
    const children = deferred();
    gateway.children = () => children.promise;
    const childLoad = wb.loadChildren({ nodeId: "2" });
    await wb.applyScope({ kind: "jql", value: "different" });
    await wb.applyScope({ kind: "jql", value: "new" });
    children.resolve({ issues: [row("99")], nextPageToken: "old-children" });
    await childLoad;
    assert.ok(!wb.issues.some(issue => issue.id === "99"));
    assert.deepEqual(wb.childPages, {});
});

test("pages are explicit, share duplicate clicks and preserve useful data and cursor on failure", async () => {
    const { wb, gateway } = fixture();
    await wb.refresh();
    assert.equal(wb.page.loaded, 1);
    assert.equal(wb.issues.length, 2);
    let reads = 0;
    const page = deferred();
    gateway.issues = async (site, project, options) => {
        reads++;
        assert.equal(options.cursor, "second");
        return page.promise;
    };
    const first = wb.loadMore(), duplicate = wb.loadMore();
    page.resolve({ issues: [row("2")], nextPageToken: null });
    await Promise.all([first, duplicate]);
    assert.equal(reads, 1);
    assert.equal(wb.page.loaded, 2);
    assert.equal(wb.page.nextPageToken, null);
    await wb.loadMore();
    assert.equal(reads, 1);
    wb.page.nextPageToken = "failed";
    gateway.issues = async () => { throw new Error("503 unavailable"); };
    const failed = await wb.loadMore();
    assert.equal(failed.issues.length, 3);
    assert.match(failed.pageError, /503/);
    assert.equal(failed.page.nextPageToken, "failed");
    assert.equal(failed.stale, false, "a failed append does not invalidate already loaded Jira items");
});

test("referenced ancestors never expand siblings; explicit child expansion is paged and context-only", async () => {
    const { wb, gateway } = fixture();
    let reads = 0;
    const original = gateway.children;
    gateway.children = (...args) => { reads++; return original(...args); };
    await wb.refresh();
    assert.equal(reads, 0);
    await wb.loadChildren({ nodeId: "1" });
    assert.equal(reads, 1);
    assert.equal(wb.childPages["1"].nextPageToken, "more-children");
    assert.equal(wb.issues.find(issue => issue.id === "3").contextOnly, true);
    assert.equal(wb.page.loaded, 1, "child context does not inflate scope totals");
    await assert.rejects(wb.prepare({ nodeId: "10" }), /context only/);
    const promoted = mergeIssues(wb.issues, [row("3")]);
    assert.equal(promoted.find(issue => issue.id === "3").contextOnly, undefined, "a later matching scope page promotes context to work");
    assert.ok(mergeIssues(promoted, [row("3", { contextOnly: true })]).find(issue => issue.id === "3").contextOnly !== true);
    gateway.children = async () => { throw new Error("Child lookup failed"); };
    const failed = await wb.loadChildren({ nodeId: "1" });
    assert.match(failed.pageError, /Child lookup failed/);
    assert.equal(failed.childPages["1"].nextPageToken, "more-children");
    assert.ok(failed.issues.some(issue => issue.id === "3"));
});

test("repeated continuation cycles and overlapping refreshes cannot append stale pages", async () => {
    const { wb, gateway } = fixture();
    await wb.refresh();
    gateway.issues = async () => ({ issues: [row("2")], nextPageToken: "third" });
    await wb.loadMore();
    gateway.issues = async () => ({ issues: [row("3")], nextPageToken: "second" });
    const repeated = await wb.loadMore();
    assert.match(repeated.pageError, /repeated a cursor/);
    assert.ok(!repeated.issues.some(issue => issue.id === "3"));
    const page = deferred();
    gateway.issues = () => page.promise;
    const refresh = wb.refresh();
    await assert.rejects(wb.loadMore(), /first scope page/);
    page.resolve({ issues: [row("4")], fetchedAt: "new" });
    await refresh;
    assert.equal(wb.page.nextPageToken, null);
    assert.ok(wb.issues.some(issue => issue.id === "4"));
    assert.ok(!wb.issues.some(issue => issue.id === "2"));
});

test("missing and id-only parents use explicit placeholders; hierarchy names come from metadata", () => {
    const child = normalizeIssue({ id: "2", key: "DEMO-2", fields: {
        issuetype: { name: "Task", hierarchyLevel: 0 }, parent: { id: "10", fields: { issuetype: { name: "Feature", hierarchyLevel: 1 } } },
    } });
    const missing = buildTree([child]);
    assert.equal(missing.roots[0].issue.missing, true);
    assert.equal(missing.roots[0].issue.type, "Feature");
    assert.equal(missing.roots[0].children[0].issue.id, "2");
    const resolved = buildTree([child, row("10", { key: "PARENT-10", type: "Feature", level: 1 })]);
    assert.equal(resolved.roots.length, 1);
    assert.equal(resolved.roots[0].issue.key, "PARENT-10");
    assert.equal(resolved.roots[0].children[0].issue.id, "2");
});

test("loaded counts, paging and child-completeness labels do not imply complete project totals", async () => {
    const { wb } = fixture();
    await wb.refresh();
    const state = await wb.snapshot();
    assert.match(workingSetSummary(state), /1 scope items loaded; 1 context items.*More scope results remain/);
    assert.match(workingSetSummary(state), /not complete child totals/);
    assert.equal(state.executions.length, 1, "ancestors do not become execution work");
    assert.equal(childLoadState(row("1")), "Load children");
    assert.equal(childLoadState(row("1"), { loaded: 2, nextPageToken: "next" }), "Load more children (2 read)");
    assert.equal(childLoadState(row("1"), { loaded: 2, nextPageToken: null }), "All 2 immediate children read");
    assert.equal(childLoadState(row("1", { level: -1 })), null);
});

test("execution evidence reads are bounded to the visible/selected nodes and captured project identity", async () => {
    const { wb, gateway, store } = fixture();
    wb.issues = Array.from({ length: 150 }, (_, index) => row(String(index + 1)));
    await store.update(data => {
        for (const issue of wb.issues) data.links[wb.selectedScope(issue.id)] = { sessions: [], prs: [] };
    });
    const read = [];
    await wb.setVisible({ workingSetKey: wb.loadKey(), nodeIds: ["2", "3"] });
    wb.trace.collectTrace = async ({ scope }) => { read.push(scope); throw new Error("test observation"); };
    await assert.rejects(wb.refreshExecution(), /test observation/);
    assert.deepEqual(read.sort(), [wb.selectedScope("2"), wb.selectedScope("3")]);
    assert.equal(gateway.children instanceof Function, true);
    await assert.rejects(wb.setVisible({ workingSetKey: "old", nodeIds: ["1"] }), /changed/);
});
