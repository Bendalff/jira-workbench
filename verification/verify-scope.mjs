import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchBrowser, screenshotPath } from "./browser.mjs";
import { createFixture, issues, scope } from "./fixture.mjs";

const directory = await mkdtemp(join(tmpdir(), "jira-workbench-scope-"));
const { workbench, gateway, store, startServer } = await createFixture({ directory });
const calls = [];
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const task = { ...issues[1], parentKey: "PARENT-101", summary: "Scoped task" };
const feature = { ...issues[0], id: "101", key: "PARENT-101", projectId: "43", type: "Feature", level: 1, parentKey: "PORT-102", summary: "Cross-project feature", contextOnly: true };
const portfolio = { ...feature, id: "102", key: "PORT-102", projectId: "44", type: "Portfolio Epic", level: 2, parentKey: null, summary: "Portfolio context" };
let failPage = true;
gateway.issues = async (site, project, options) => {
    calls.push({ kind: "scope", ...options });
    if (options.scope.value === "invalid") throw new Error("Synthetic invalid scope");
    if (options.cursor) {
        if (failPage) throw new Error("Synthetic page outage");
        return { issues: [{ ...issues[5], parentKey: feature.key }], total: 2, nextPageToken: null, fetchedAt: new Date().toISOString() };
    }
    return { issues: [task], total: 2, nextPageToken: "page-two", fetchedAt: new Date().toISOString() };
};
gateway.ancestors = async () => ({ issues: [feature, portfolio], warnings: [] });
gateway.children = async (site, parent, options) => {
    calls.push({ kind: "children", id: parent.id, cursor: options.cursor });
    return options.cursor ? { issues: [], nextPageToken: null, total: 1 } : {
        issues: [{ ...issues[7], id: "103", key: "TEAM-103", parentKey: feature.key, projectId: "45", level: 0, summary: "Other team child" }],
        nextPageToken: "children-two", total: 1,
    };
};
await workbench.catalog();
await workbench.select({ cloudId: "demo-site", jiraProjectId: "42" });
await workbench.idle();
const server = await startServer(workbench);
const browser = await launchBrowser();
const page = await browser.newPage({ viewport: { width: 1440, height: 1080 } });
const errors = [];
page.on("pageerror", error => errors.push(error.message));

try {
    await page.goto(server.url);
    await page.getByLabel("Search loaded items", { exact: true }).waitFor();
    await page.waitForFunction(() => document.getElementById("scope-summary").textContent.includes("1 scope items loaded of 2"));
    assert.equal(calls.filter(call => call.kind === "scope").length, 1, "initial load does not crawl");
    assert.equal(calls.filter(call => call.kind === "children").length, 0);
    await page.locator("#scope-kind").selectOption("jql");
    await page.locator("#scope-value").fill("assignee = currentUser()");
    assert.equal(calls.filter(call => call.kind === "scope").length, 1, "editing scope does not read Jira");
    const applyEntered = deferred(), applyRelease = deferred();
    await page.route("**/api/scope", async route => {
        applyEntered.resolve();
        await applyRelease.promise;
        await route.continue();
    });
    await page.locator("#apply-scope").focus();
    await page.keyboard.press("Enter");
    await applyEntered.promise;
    assert.match(await page.locator("#connection-status").innerText(), /Applying scope/);
    assert.equal(await page.locator("#apply-scope").getAttribute("aria-busy"), "true");
    applyRelease.resolve();
    await page.waitForFunction(() => !document.getElementById("apply-scope").disabled);
    assert.equal(await page.locator("#apply-scope").evaluate(element => element === document.activeElement), true, "Apply restores keyboard focus");
    await page.unroute("**/api/scope");
    assert.equal((await store.read()).preferences[scope].workingScope.value, "assignee = currentUser()");
    await page.locator("#load-more").click();
    await page.waitForFunction(() => document.getElementById("errors").innerText.includes("Synthetic page outage"));
    assert.equal(await page.locator("#load-more").evaluate(element => element === document.activeElement), true, "failed page restores retry control focus");
    assert.ok((await workbench.snapshot()).issues.some(issue => issue.id === task.id));
    assert.equal(workbench.page.nextPageToken, "page-two", "failed page keeps its continuation");
    await page.locator("#scope-value").fill("invalid");
    await page.locator("#apply-scope").click();
    await page.waitForFunction(() => !document.getElementById("apply-scope").disabled);
    assert.match(await page.locator("#connection-status").innerText(), /Scope was not applied: Synthetic invalid scope/);
    assert.doesNotMatch(await page.locator("#connection-status").innerText(), /Scope applied\./);
    assert.match((await workbench.snapshot()).pageError, /Synthetic page outage.*\nScope was not applied/);
    failPage = false;
    await page.locator("#load-more").click();
    await page.locator("#load-more").waitFor({ state: "hidden" });
    await page.waitForFunction(() => document.activeElement !== document.body && document.activeElement.id !== "load-more");
    assert.equal(workbench.page.loaded, 2);
    await page.locator("#view-hierarchy").click();
    await page.getByRole("treeitem", { name: /PARENT-101 Cross-project feature/ }).waitFor();
    await page.getByRole("treeitem", { name: /PORT-102 Portfolio context/ }).waitFor();
    assert.equal(calls.filter(call => call.kind === "children").length, 0, "rendering context never fetches children");
    const featureRow = page.getByRole("treeitem", { name: /PARENT-101 Cross-project feature/ });
    assert.match(await featureRow.innerText(), /Context only/);
    await featureRow.getByRole("button", { name: "Load children", exact: true }).click();
    await page.getByRole("treeitem", { name: /TEAM-103 Other team child/ }).waitFor();
    assert.equal(calls.filter(call => call.kind === "children").length, 1);
    assert.equal(workbench.page.loaded, 2, "context children do not inflate working-set counts");
    assert.equal(await featureRow.getByRole("button", { name: /Load more children/ }).evaluate(element => element === document.activeElement), true, "child paging restores the replacement button");
    await featureRow.getByRole("button", { name: /Load more children/ }).click();
    await featureRow.getByRole("button", { name: "All 1 immediate children read", exact: true }).waitFor();
    assert.equal(calls.filter(call => call.kind === "children").length, 2);
    await page.waitForFunction(() => document.activeElement?.getAttribute("role") === "treeitem");
    await featureRow.click();
    await page.getByText("Select this item's own Jira project to view, link or refresh", { exact: false }).waitFor();
    assert.equal(await page.getByRole("button", { name: "Link session", exact: true }).count(), 0);
    await page.locator("#scope-kind").selectOption("filter");
    await page.locator("#scope-value").fill("123");
    await page.locator("#apply-scope").click();
    await page.waitForFunction(() => !document.getElementById("apply-scope").disabled);
    assert.deepEqual(workbench.workingScope, { kind: "filter", value: "123" });
    assert.ok(!workbench.issues.some(issue => issue.id === "103"), "scope switches drop expanded context");

    // A delayed failed response must not restore the former scope after Apply.
    const oldPageEntered = deferred(), oldPageRelease = deferred();
    await page.route("**/api/load-more", async route => {
        const response = await route.fetch();
        const snapshot = await response.json();
        snapshot.pageError = "Old delayed page failure";
        snapshot.pageResult = { target: "working-set", status: "failed", error: snapshot.pageError };
        oldPageEntered.resolve();
        await oldPageRelease.promise;
        await route.fulfill({ response, json: snapshot });
    });
    await page.locator("#load-more").click();
    await oldPageEntered.promise;
    await page.locator("#scope-value").fill("456");
    await page.locator("#apply-scope").click();
    await page.waitForFunction(() => !document.getElementById("apply-scope").disabled);
    oldPageRelease.resolve();
    await page.waitForResponse(response => response.url().endsWith("/api/load-more"));
    await page.unroute("**/api/load-more");
    assert.equal(await page.locator("#scope-value").inputValue(), "456");
    assert.doesNotMatch(await page.locator("#errors").innerText(), /Old delayed/);

    const visibility = [];
    page.on("request", request => { if (request.url().endsWith("/api/visible")) visibility.push(request.postDataJSON()); });
    await page.locator("#apply-scope").click();
    await page.waitForFunction(() => !document.getElementById("apply-scope").disabled);
    await page.waitForRequest(request => request.url().endsWith("/api/visible"));
    assert.ok(visibility.some(input => input.generation === workbench.refreshGeneration && input.revision > 0), "same-scope apply sends versioned visibility again");

    // Superseding Apply clears its status, without clearing the project's saved selection/collapse state.
    await page.locator("#view-hierarchy").click();
    await page.getByRole("treeitem", { name: /DEMO-2 Scoped task/ }).click();
    const savedView = page.waitForResponse(response => response.url().endsWith("/api/preferences") && response.ok());
    await featureRow.getByRole("button", { name: "Collapse PARENT-101", exact: true }).click();
    await savedView;
    const heldApply = deferred(), releaseApply = deferred();
    await page.route("**/api/scope", async route => {
        const response = await route.fetch();
        heldApply.resolve();
        await releaseApply.promise;
        await route.fulfill({ response });
    });
    await page.locator("#apply-scope").click();
    await heldApply.promise;
    await store.update(data => { data.preferences["demo-site/43/project"] = { workingScope: { kind: "filter", value: "456" } }; });
    await page.locator("#project").selectOption("43");
    await page.waitForFunction(() => document.getElementById("scope-value").value === "456");
    assert.doesNotMatch(await page.locator("#connection-status").innerText(), /Applying scope/);
    releaseApply.resolve();
    await page.waitForResponse(response => response.url().endsWith("/api/scope"));
    await page.unroute("**/api/scope");

    // Identical saved definitions in different projects must not retain an unsaved draft.
    await page.locator("#scope-value").fill("unapplied draft");
    await page.locator("#project").selectOption("42");
    await page.waitForFunction(() => document.getElementById("project-title").textContent === "Daily execution demo");
    await page.waitForFunction(() => document.getElementById("scope-value").value === "456");
    await featureRow.getByRole("button", { name: "Expand PARENT-101", exact: true }).waitFor();
    const savedSelection = await store.read();
    assert.equal(savedSelection.preferences[scope].selected, task.id);
    assert.ok(savedSelection.preferences[scope].collapsed.includes("101"));

    await page.evaluate(() => {
        window.summaryMutations = 0;
        new MutationObserver(records => { window.summaryMutations += records.length; }).observe(document.getElementById("scope-summary"), { childList: true });
    });
    await page.locator("#refresh-execution").click();
    await page.waitForFunction(() => !document.getElementById("refresh-execution").disabled);
    assert.equal(await page.evaluate(() => window.summaryMutations), 0, "unchanged snapshots do not repeat live summary announcements");
    await page.reload();
    await page.waitForFunction(() => document.getElementById("scope-value").value === "456");
    await page.locator("#view-hierarchy").click();
    await page.getByRole("treeitem", { name: /PARENT-101 Cross-project feature/ }).waitFor();
    await featureRow.getByRole("button", { name: "Expand PARENT-101", exact: true }).click();

    const pageEntered = deferred(), pageRelease = deferred();
    const readIssues = gateway.issues;
    gateway.issues = async (...args) => {
        if (args[2].cursor) { pageEntered.resolve(); await pageRelease.promise; }
        return readIssues(...args);
    };
    await page.locator("#load-more").click();
    await pageEntered.promise;
    await page.locator("#refresh").click();
    await page.waitForFunction(() => !document.getElementById("refresh").disabled);
    pageRelease.resolve();
    await page.waitForFunction(() => document.getElementById("notice").innerText.includes("superseded"));
    assert.doesNotMatch(await page.locator("#notice").innerText(), /Working-set page loaded/);
    gateway.issues = readIssues;

    // A -> B (still in flight) -> A must send a newer report even though A was acknowledged.
    await page.reload();
    await page.waitForFunction(() => document.getElementById("scope-value").value === "456");
    await page.locator("#view-hierarchy").click();
    await featureRow.getByRole("button", { name: "Expand PARENT-101", exact: true }).click();
    await page.getByRole("treeitem", { name: /PORT-102 Portfolio context/ }).click();
    await page.waitForRequest(request => request.url().endsWith("/api/visible") && request.postDataJSON().nodeIds.includes(task.id));
    const bEntered = deferred(), releaseB = deferred();
    let bRevision;
    await page.route("**/api/visible", async route => {
        const input = route.request().postDataJSON();
        const response = await route.fetch();
        if (!input.nodeIds.includes(task.id)) {
            bRevision = input.revision;
            bEntered.resolve();
            await releaseB.promise;
        }
        await route.fulfill({ response });
    });
    await page.locator("#search").fill("Portfolio context");
    await bEntered.promise;
    const restoredA = page.waitForResponse(response => response.url().endsWith("/api/visible")
        && response.request().postDataJSON().revision > bRevision && response.request().postDataJSON().nodeIds.includes(task.id));
    await page.locator("#search").fill("");
    await restoredA;
    releaseB.resolve();
    await page.unroute("**/api/visible", { behavior: "wait" });
    assert.ok(workbench.evidenceNodes.has(task.id), "returning to A supersedes in-flight B");
    await page.screenshot({ path: screenshotPath("scoped-loading.png") });
    assert.deepEqual(errors, []);
    console.log("PASS: transactional scopes, bounded pages/retry, cross-project hierarchy and trace isolation, lazy children, stale/superseded page outcomes, versioned same-scope and A-B-A visibility, restored per-project selection/collapse and drafts, accurate failed/superseded Apply status, stable live summaries, and keyboard focus. All services were synthetic; no Jira writes.");
} finally {
    await browser.close();
    await server.close();
    workbench.close();
    await workbench.idle();
    await rm(directory, { recursive: true, force: true });
}
