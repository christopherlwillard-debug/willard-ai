import assert from "node:assert/strict";
import test from "node:test";
import { authorizeFirstRunSetup, isLoopbackAddress } from "../lib/setup-authorization.ts";

const token = "a".repeat(64);

test("loopback IPv4 and IPv6 clients can complete local desktop setup without a token", () => {
  for (const address of ["127.0.0.1", "127.0.0.2", "::1", "::ffff:127.0.0.1"]) {
    assert.equal(isLoopbackAddress(address), true, address);
    assert.equal(authorizeFirstRunSetup({
      remoteAddress: address,
      allowLoopbackSetup: true,
      configuredToken: undefined,
      suppliedToken: undefined,
    }), "local");
  }
});

test("LAN and public clients cannot claim first-run administrator access without server configuration", () => {
  for (const address of ["192.168.1.20", "10.0.0.5", "203.0.113.8", "2001:db8::8"]) {
    assert.equal(isLoopbackAddress(address), false, address);
    assert.equal(authorizeFirstRunSetup({
      remoteAddress: address,
      allowLoopbackSetup: false,
      configuredToken: undefined,
      suppliedToken: undefined,
    }), "token_misconfigured");
  }
});

test("remote setup fails closed when the configured token is missing or too short", () => {
  assert.equal(authorizeFirstRunSetup({
    remoteAddress: "203.0.113.8",
    allowLoopbackSetup: false,
    configuredToken: "short",
    suppliedToken: "short",
  }), "token_misconfigured");
});

test("remote setup requires the exact configured token", () => {
  const base = { remoteAddress: "203.0.113.8", allowLoopbackSetup: false, configuredToken: token };
  assert.equal(authorizeFirstRunSetup({ ...base, suppliedToken: undefined }), "token_required");
  assert.equal(authorizeFirstRunSetup({ ...base, suppliedToken: "b".repeat(64) }), "token_invalid");
  assert.equal(authorizeFirstRunSetup({ ...base, suppliedToken: token }), "authorized");
});

test("IPv4-mapped loopback is local but IPv4-mapped LAN addresses are not", () => {
  assert.equal(isLoopbackAddress("::ffff:127.0.0.1"), true);
  assert.equal(isLoopbackAddress("::ffff:192.168.1.20"), false);
});

test("a loopback socket peer alone does not bypass remote setup authorization", () => {
  // A same-host reverse proxy can make a remote browser appear as 127.0.0.1.
  for (const address of ["127.0.0.1", "::1", "::ffff:127.0.0.1"]) {
    assert.equal(authorizeFirstRunSetup({
      remoteAddress: address,
      allowLoopbackSetup: false,
      configuredToken: undefined,
      suppliedToken: undefined,
    }), "token_misconfigured", address);
  }
});

test("the local bypass requires explicit launcher opt-in and still rejects non-loopback peers", () => {
  assert.equal(authorizeFirstRunSetup({
    remoteAddress: "127.0.0.1",
    allowLoopbackSetup: true,
    configuredToken: undefined,
    suppliedToken: undefined,
  }), "local");
  assert.equal(authorizeFirstRunSetup({
    remoteAddress: "192.168.1.20",
    allowLoopbackSetup: true,
    configuredToken: undefined,
    suppliedToken: undefined,
  }), "token_misconfigured");
});
