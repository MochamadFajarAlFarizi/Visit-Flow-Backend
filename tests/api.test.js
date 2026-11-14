import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/app.js";
import { resetStore } from "../src/data/store.js";

process.env.NODE_ENV = "test";

let server;
let baseUrl;

async function loginAs(email = "andi@visitflow.id", password = "password123") {
  const res = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  const body = await res.json();
  return { res, body };
}

describe("Visit Flow Backend API & RBAC", () => {
  before(async () => {
    const app = createApp();
    await new Promise((resolve) => {
      server = app.listen(0, "127.0.0.1", () => {
        const address = server.address();
        baseUrl = `http://127.0.0.1:${address.port}`;
        resolve();
      });
    });
  });

  beforeEach(() => {
    resetStore();
  });

  after(async () => {
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it("rejects unauthenticated requests and URL query token manipulation", async () => {
    const actRes = await fetch(`${baseUrl}/api/activities`);
    assert.equal(actRes.status, 401);

    const entRes = await fetch(`${baseUrl}/api/entities`);
    assert.equal(entRes.status, 401);

    const usersRes = await fetch(`${baseUrl}/api/users`);
    assert.equal(usersRes.status, 401);

    const { body: auth } = await loginAs();
    const urlBypassRes = await fetch(
      `${baseUrl}/api/activities?token=${auth.token}`
    );
    assert.equal(urlBypassRes.status, 401);

    const userBypassRes = await fetch(
      `${baseUrl}/api/activities?user=usr-001`,
      {
        headers: { Authorization: `Bearer ${auth.token}` },
      }
    );
    assert.equal(userBypassRes.status, 401);
  });

  it("authenticates demo user and rejects wrong credentials", async () => {
    const invalid = await loginAs("andi@visitflow.id", "salah-password");
    assert.equal(invalid.res.status, 401);
    assert.ok(invalid.body.error);

    const valid = await loginAs("andi@visitflow.id", "password123");
    assert.equal(valid.res.status, 200);
    assert.ok(valid.body.token);
    assert.equal(valid.body.user.name, "Andi Pratama");
    assert.equal(valid.body.user.role, "SALES");
  });

  it("isolates SALES user to only their own activities and blocks modifying other users' activities", async () => {
    const { body: andiAuth } = await loginAs("andi@visitflow.id", "password123");
    const headers = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${andiAuth.token}`,
    };

    const listRes = await fetch(`${baseUrl}/api/activities`, { headers });
    assert.equal(listRes.status, 200);
    const listPayload = await listRes.json();
    assert.equal(listPayload.data.length, 3);
    assert.equal(listPayload.summary.total, 3);
    for (const item of listPayload.data) {
      assert.equal(item.salesName, "Andi Pratama");
    }

    // Cannot filter to see another sales user's data
    const budiFilterRes = await fetch(
      `${baseUrl}/api/activities?salesName=Budi%20Santoso`,
      { headers }
    );
    assert.equal(budiFilterRes.status, 200);
    const budiFilterPayload = await budiFilterRes.json();
    assert.equal(budiFilterPayload.data.length, 0);

    // Cannot PATCH Budi's activity (act-002)
    const patchOtherRes = await fetch(`${baseUrl}/api/activities/act-002`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ status: "VISITED" }),
    });
    assert.equal(patchOtherRes.status, 403);

    // Cannot POST activity assigned to another sales person
    const postOtherRes = await fetch(`${baseUrl}/api/activities`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        entityId: "ent-001",
        segment: "B2G",
        visitDate: "2026-03-22",
        salesName: "Budi Santoso",
      }),
    });
    assert.equal(postOtherRes.status, 403);
  });

  it("allows SUPER_ADMIN to access all visit activities and filter across all sales", async () => {
    const { body: adminAuth } = await loginAs("admin@visitflow.id", "password123");
    assert.equal(adminAuth.user.role, "SUPER_ADMIN");

    const headers = { Authorization: `Bearer ${adminAuth.token}` };
    const allRes = await fetch(`${baseUrl}/api/activities`, { headers });
    assert.equal(allRes.status, 200);
    const allPayload = await allRes.json();
    assert.equal(allPayload.data.length, 10);
    assert.equal(allPayload.summary.total, 10);

    const filteredRes = await fetch(
      `${baseUrl}/api/activities?segment=B2G&status=VISITED&from=2026-03-01&to=2026-03-05&search=melati&salesName=Andi`,
      { headers }
    );
    assert.equal(filteredRes.status, 200);
    const filteredPayload = await filteredRes.json();
    assert.equal(filteredPayload.data.length, 2);
    assert.deepEqual(filteredPayload.summary, {
      total: 2,
      visited: 2,
      notVisited: 0,
      b2g: 2,
      b2b: 0,
    });
  });

  it("allows SUPER_ADMIN to create and list user accounts while blocking non-admin SALES users", async () => {
    const { body: salesAuth } = await loginAs("andi@visitflow.id", "password123");
    const salesHeaders = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${salesAuth.token}`,
    };

    const forbiddenList = await fetch(`${baseUrl}/api/users`, {
      headers: salesHeaders,
    });
    assert.equal(forbiddenList.status, 403);

    const forbiddenCreate = await fetch(`${baseUrl}/api/users`, {
      method: "POST",
      headers: salesHeaders,
      body: JSON.stringify({
        name: "Eko Wijaya",
        email: "eko@visitflow.id",
        password: "password123",
        role: "SALES",
        region: "Surabaya",
      }),
    });
    assert.equal(forbiddenCreate.status, 403);

    const { body: adminAuth } = await loginAs("admin@visitflow.id", "password123");
    const adminHeaders = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${adminAuth.token}`,
    };

    const createRes = await fetch(`${baseUrl}/api/users`, {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({
        name: "Eko Wijaya",
        email: "eko@visitflow.id",
        password: "password123",
        role: "SALES",
        region: "Surabaya",
      }),
    });
    assert.equal(createRes.status, 201);
    const createdUser = await createRes.json();
    assert.equal(createdUser.email, "eko@visitflow.id");
    assert.equal(createdUser.role, "SALES");

    const usersListRes = await fetch(`${baseUrl}/api/users`, {
      headers: adminHeaders,
    });
    assert.equal(usersListRes.status, 200);
    const usersList = await usersListRes.json();
    assert.ok(usersList.data.some((u) => u.email === "eko@visitflow.id"));

    // Newly created user logs in and sees 0 activities until they create their own
    const { body: ekoAuth } = await loginAs("eko@visitflow.id", "password123");
    assert.ok(ekoAuth.token);
    const ekoHeaders = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${ekoAuth.token}`,
    };

    const ekoInitial = await fetch(`${baseUrl}/api/activities`, {
      headers: ekoHeaders,
    });
    const ekoInitialPayload = await ekoInitial.json();
    assert.equal(ekoInitialPayload.data.length, 0);
    assert.equal(ekoInitialPayload.summary.total, 0);

    const ekoCreate = await fetch(`${baseUrl}/api/activities`, {
      method: "POST",
      headers: ekoHeaders,
      body: JSON.stringify({
        entityId: "ent-004",
        segment: "B2B",
        visitDate: "2026-03-30",
      }),
    });
    assert.equal(ekoCreate.status, 201);

    const ekoAfter = await fetch(`${baseUrl}/api/activities`, {
      headers: ekoHeaders,
    });
    const ekoAfterPayload = await ekoAfter.json();
    assert.equal(ekoAfterPayload.data.length, 1);
    assert.equal(ekoAfterPayload.data[0].salesName, "Eko Wijaya");

    // Update user via PUT /api/users/:id (propagates salesName to activities)
    const updateRes = await fetch(`${baseUrl}/api/users/${createdUser.id}`, {
      method: "PUT",
      headers: adminHeaders,
      body: JSON.stringify({
        name: "Eko Wijaya Kusuma",
        email: "eko.kusuma@visitflow.id",
        role: "SALES",
        region: "Malang",
      }),
    });
    assert.equal(updateRes.status, 200);
    const updatedUser = await updateRes.json();
    assert.equal(updatedUser.name, "Eko Wijaya Kusuma");
    assert.equal(updatedUser.region, "Malang");

    // Self-delete by admin is blocked
    const selfDeleteRes = await fetch(
      `${baseUrl}/api/users/${adminAuth.user.id}`,
      {
        method: "DELETE",
        headers: adminHeaders,
      }
    );
    assert.equal(selfDeleteRes.status, 400);

    // Delete created user via DELETE /api/users/:id
    const deleteRes = await fetch(`${baseUrl}/api/users/${createdUser.id}`, {
      method: "DELETE",
      headers: adminHeaders,
    });
    assert.equal(deleteRes.status, 200);
    const deleteBody = await deleteRes.json();
    assert.equal(deleteBody.deleted, true);
  });

  it("rejects invalid or manipulated query parameters on GET /api/activities", async () => {
    const { body: auth } = await loginAs();
    const headers = { Authorization: `Bearer ${auth.token}` };

    const badSegment = await fetch(`${baseUrl}/api/activities?segment=INVALID`, {
      headers,
    });
    assert.equal(badSegment.status, 400);

    const badStatus = await fetch(`${baseUrl}/api/activities?status=HACK`, {
      headers,
    });
    assert.equal(badStatus.status, 400);

    const badRange = await fetch(
      `${baseUrl}/api/activities?from=2026-03-31&to=2026-03-01`,
      { headers }
    );
    assert.equal(badRange.status, 400);
  });

  it("validates and creates a new visit plan via POST /api/activities and updates own status via PATCH", async () => {
    const { body: auth } = await loginAs("andi@visitflow.id", "password123");
    const headers = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${auth.token}`,
    };

    const badRes = await fetch(`${baseUrl}/api/activities`, {
      method: "POST",
      headers,
      body: JSON.stringify({ entityId: "", segment: "B2G", visitDate: "2026-03-15" }),
    });
    assert.equal(badRes.status, 400);

    const createRes = await fetch(`${baseUrl}/api/activities`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        entityId: "ent-001",
        segment: "B2G",
        visitDate: "2026-03-15",
      }),
    });
    assert.equal(createRes.status, 201);

    const created = await createRes.json();
    assert.equal(created.salesName, "Andi Pratama");
    assert.equal(created.status, "NOT_VISITED");

    const markVisited = await fetch(`${baseUrl}/api/activities/${created.id}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ status: "VISITED" }),
    });
    assert.equal(markVisited.status, 200);
    const updatedVisited = await markVisited.json();
    assert.equal(updatedVisited.status, "VISITED");
    assert.ok(updatedVisited.visitedAt);
  });

  it("returns master entities, falls back to scoped history when needed, deduplicates, and disambiguates similar names by type", async () => {
    const { body: auth } = await loginAs("andi@visitflow.id", "password123");
    const headers = { Authorization: `Bearer ${auth.token}` };

    // Similar names in master data ("Kantor Layanan Melati" Instansi vs Puskesmas)
    const masterRes = await fetch(
      `${baseUrl}/api/entities?segment=B2G&search=melati`,
      { headers }
    );
    assert.equal(masterRes.status, 200);
    const masterEntities = await masterRes.json();
    assert.equal(masterEntities.length, 2);
    assert.equal(masterEntities[0].hasSimilarName, true);
    assert.notEqual(masterEntities[0].type, masterEntities[1].type);

    // Fallback from Andi's own visit history ("Koperasi Pegawai Melati")
    const fallbackOwnRes = await fetch(
      `${baseUrl}/api/entities?segment=B2G&search=Koperasi%20Pegawai%20Melati`,
      { headers }
    );
    assert.equal(fallbackOwnRes.status, 200);
    const fallbackOwn = await fallbackOwnRes.json();
    assert.equal(fallbackOwn.length, 1);
    assert.equal(fallbackOwn[0].id, "ent-hist-001");
    assert.equal(fallbackOwn[0].source, "HISTORY");

    // Budi's history entity ("CV Cipta Karya Elektrik") is isolated from Andi
    const fallbackOtherRes = await fetch(
      `${baseUrl}/api/entities?segment=B2B&search=Cipta%20Karya`,
      { headers }
    );
    assert.equal(fallbackOtherRes.status, 200);
    const fallbackOther = await fallbackOtherRes.json();
    assert.equal(fallbackOther.length, 0);
  });
});
