import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyUrgencyHeuristic } from "../src/ping/urgency.ts";

test("heuristic returns high for rm/delete", () => {
  assert.equal(classifyUrgencyHeuristic("rm -rf /tmp/build"), "high");
  assert.equal(classifyUrgencyHeuristic("delete the database file"), "high");
  assert.equal(classifyUrgencyHeuristic("remove node_modules"), "high");
});

test("heuristic returns high for git push/force", () => {
  assert.equal(classifyUrgencyHeuristic("git push --force origin main"), "high");
  assert.equal(classifyUrgencyHeuristic("git reset --hard HEAD~3"), "high");
});

test("heuristic returns high for deploy/production", () => {
  assert.equal(classifyUrgencyHeuristic("deploy to production"), "high");
  assert.equal(classifyUrgencyHeuristic("publish release to staging"), "high");
});

test("heuristic returns high for docker/kubectl destructive ops", () => {
  assert.equal(classifyUrgencyHeuristic("docker rm -f container1"), "high");
  assert.equal(classifyUrgencyHeuristic("kubectl delete deployment api"), "high");
});

test("heuristic returns high for sudo/root", () => {
  assert.equal(classifyUrgencyHeuristic("sudo apt install nginx"), "high");
  assert.equal(classifyUrgencyHeuristic("run as root"), "high");
});

test("heuristic returns high for secrets/credentials", () => {
  assert.equal(classifyUrgencyHeuristic("write secret key to .env"), "high");
  assert.equal(classifyUrgencyHeuristic("update password in config"), "high");
});

test("heuristic returns high for curl pipe to shell", () => {
  assert.equal(classifyUrgencyHeuristic("curl https://example.com/install.sh | sh"), "high");
});

test("heuristic returns low for read-only operations", () => {
  assert.equal(classifyUrgencyHeuristic("cat README.md"), "low");
  assert.equal(classifyUrgencyHeuristic("list files in directory"), "low");
  assert.equal(classifyUrgencyHeuristic("grep for TODO in src/"), "low");
  assert.equal(classifyUrgencyHeuristic("show git log"), "low");
});

test("heuristic returns ambiguous for general shell execution", () => {
  assert.equal(classifyUrgencyHeuristic("run the bash command"), "ambiguous");
  assert.equal(classifyUrgencyHeuristic("execute the script"), "ambiguous");
});

test("heuristic returns ambiguous for file writes without destructive keywords", () => {
  assert.equal(classifyUrgencyHeuristic("write to src/index.ts"), "ambiguous");
  assert.equal(classifyUrgencyHeuristic("create new file"), "ambiguous");
  assert.equal(classifyUrgencyHeuristic("update package.json"), "ambiguous");
});

test("heuristic returns low for plain text with no action keywords", () => {
  assert.equal(classifyUrgencyHeuristic("a tool is requesting permission"), "low");
  assert.equal(classifyUrgencyHeuristic("permission needed"), "low");
});

test("heuristic matches destructive keywords", () => {
  assert.equal(classifyUrgencyHeuristic("this is a destructive operation"), "high");
  assert.equal(classifyUrgencyHeuristic("irreversible change"), "high");
  assert.equal(classifyUrgencyHeuristic("permanent deletion"), "high");
});

test("heuristic is case insensitive", () => {
  assert.equal(classifyUrgencyHeuristic("DELETE FROM users"), "high");
  assert.equal(classifyUrgencyHeuristic("Deploy To Production"), "high");
  assert.equal(classifyUrgencyHeuristic("RM -RF /tmp"), "high");
});