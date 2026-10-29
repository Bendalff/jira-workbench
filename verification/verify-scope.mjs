import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchBrowser, screenshotPath } from "./browser.mjs";
import { createFixture, issues, scope } from "./fixture.mjs";

const directory = await mkdtemp(join(tmpdir(), "jira-workbench-scope-"));
const { workbench, gateway, store, startServer } = await createFixture({ directory });
const calls = [];
const task = { ...issues[1], parentKey: "PARENT-101", summary: "Scoped task" };
const feature = { ...issues[0], id: "101", key: "PARENT-101", projectId: "43", type: "Feature", level: 1, parentKey: "PORT-102", summary: "Cross-project feature", contextOnly: true };
const portfolio = { ...feature, id: "102", key: "PORT-102", projectId: "44", type: "Portfolio Epic", level: 2, parentKey: null, summary: "Portfolio context" };
let failPage = true;
gateway.issues = async (site, project, options) => {
    calls.push({ kind: "scope", ...options });
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
    await page.locator("#apply-scope").click();
    await page.waitForFunction(() => !document.getElementById("apply-scope").disabled);
    assert.equal((await store.read()).preferences[scope].workingScope.value, "assignee = currentUser()");
    await page.locator("#load-more").click();
    await page.waitForFunction(() => document.getElementById("errors").innerText.includes("Synthetic page outage"));
    assert.ok((await workbench.snapshot()).issues.some(issue => issue.id === task.id));
    assert.equal(workbench.page.nextPageToken, "page-two", "failed page keeps its continuation");
    failPage = false;
    await page.locator("#load-more").click();
    await page.locator("#load-more").waitFor({ state: "hidden" });
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
    await featureRow.getByRole("button", { name: /Load more children/ }).click();
    await featureRow.getByRole("button", { name: "All 1 immediate children read", exact: true }).waitFor();
    assert.equal(calls.filter(call => call.kind === "children").length, 2);
    await page.locator("#scope-kind").selectOption("filter");
    await page.locator("#scope-value").fill("123");
    await page.locator("#apply-scope").click();
    await page.waitForFunction(() => !document.getElementById("apply-scope").disabled);
    assert.deepEqual(workbench.workingScope, { kind: "filter", value: "123" });
    assert.ok(!workbench.issues.some(issue => issue.id === "103"), "scope switches drop expanded context");
    await page.reload();
    await page.waitForFunction(() => document.getElementById("scope-value").value === "123");
    await page.locator("#view-hierarchy").click();
    await page.getByRole("treeitem", { name: /PARENT-101 Cross-project feature/ }).waitFor();
    await page.screenshot({ path: screenshotPath("scoped-loading.png") });
    assert.deepEqual(errors, []);
    console.log("PASS: explicit persisted JQL/filter scopes, bounded initial load, real cursor continuation, retained useful data and retry after page failure, cross-project Feature/Portfolio hierarchy, context-only labels, lazy paged children, isolated scope switches and loaded counts. All services were synthetic; no Jira writes.");
} finally {
    await browser.close();
    await server.close();
    workbench.close();
    await workbench.idle();
    await rm(directory, { recursive: true, force: true });
}
