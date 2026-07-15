/**
 * Documents+ DMS tests against jenga_test:
 *  - folder CRUD: create, nest, rename, move, and the empty-guard on delete
 *    (a folder with a doc or a child folder refuses to delete),
 *  - upload with metadata (folder, category, tags, description, expiry) and
 *    validation of category / date / folder existence,
 *  - metadata PATCH moves, retags and recategorizes without re-uploading bytes,
 *  - the filtered list (folder, category, tag, q, expiringInDays),
 *  - the expiring compliance query and the category summary.
 */
import { randomUUID } from "node:crypto";
import type { TenantTokenClaims } from "@jenga/shared";
import { DbService } from "../src/db/db.service";
import { DocumentsController } from "../src/tenants/documents.controller";

process.env.APP_DB_URL =
  process.env.APP_DB_URL_TEST ??
  "postgres://jenga_app:app_dev_pw@localhost:5432/jenga_test";
process.env.WORKER_DB_URL =
  process.env.WORKER_DB_URL_TEST ??
  "postgres://jenga_worker:worker_dev_pw@localhost:5432/jenga_test";

const b64 = (s: string): string => Buffer.from(s).toString("base64");
const daysFromNow = (n: number): string =>
  new Date(Date.now() + n * 86400_000).toISOString().slice(0, 10);

describe("documents+ (folders, metadata, expiry, summary)", () => {
  const db = new DbService();
  const controller = new DocumentsController(db);

  let tenant: string;
  let owner: string;
  let claims: TenantTokenClaims;

  const upload = (body: Record<string, unknown>) =>
    controller.upload(claims, {
      name: "file.pdf",
      mime: "application/pdf",
      dataBase64: b64("hello world"),
      ...body,
    });

  beforeAll(async () => {
    const suffix = randomUUID().slice(0, 8);
    owner = (
      await db.query(
        `INSERT INTO users (email, password_hash, full_name)
         VALUES ($1, 'x', 'Docs Owner') RETURNING id`,
        [`docs-${suffix}@test.local`],
      )
    ).rows[0].id;
    tenant = (
      await db.query("SELECT create_tenant_with_owner($1, $2, $3) AS id", [
        "docs-co",
        `docs-co-${suffix}`,
        owner,
      ])
    ).rows[0].id;
    claims = { sub: owner, tid: tenant, rol: "owner", typ: "tenant" };
  });

  afterAll(async () => {
    await db.onModuleDestroy();
  });

  let root: string;
  let child: string;

  it("creates, nests and lists folders with doc counts", async () => {
    const f = await controller.createFolder(claims, { name: "Contracts" });
    root = f.id;
    expect(f.name).toBe("Contracts");
    expect(f.parent_id).toBeNull();

    const c = await controller.createFolder(claims, {
      name: "2026",
      parentId: root,
    });
    child = c.id;
    expect(c.parent_id).toBe(root);

    await expect(
      controller.createFolder(claims, { name: "  " }),
    ).rejects.toThrow(/name is required/);
    await expect(
      controller.createFolder(claims, { name: "x", parentId: randomUUID() }),
    ).rejects.toThrow(/Parent folder not found/);

    const folders = await controller.listFolders(claims);
    const rootRow = folders.find((r: { id: string }) => r.id === root);
    expect(rootRow.child_count).toBe(1);
    expect(rootRow.doc_count).toBe(0);
  });

  it("renames, moves and blocks cyclic folder moves", async () => {
    const renamed = await controller.updateFolder(claims, root, {
      name: "Legal",
    });
    expect(renamed.name).toBe("Legal");

    // Moving a folder into its own descendant is a cycle → 400.
    await expect(
      controller.updateFolder(claims, root, { parentId: child }),
    ).rejects.toThrow(/own subtree/);
    await expect(
      controller.updateFolder(claims, root, { parentId: root }),
    ).rejects.toThrow(/own parent/);

    // A legit move to top level (child → root of tree).
    const sibling = await controller.createFolder(claims, { name: "Misc" });
    const moved = await controller.updateFolder(claims, child, {
      parentId: sibling.id,
    });
    expect(moved.parent_id).toBe(sibling.id);
    // put it back for later assertions
    await controller.updateFolder(claims, child, { parentId: root });
  });

  let docId: string;

  it("uploads with metadata and validates it", async () => {
    const d = await upload({
      name: "MSA.pdf",
      folderId: root,
      category: "contract",
      tags: ["signed", "priority", "signed"],
      description: "Master service agreement",
      expiresOn: daysFromNow(20),
    });
    docId = d.id;
    expect(d.category).toBe("contract");
    expect(d.folder_id).toBe(root);

    await expect(upload({ category: "banana" })).rejects.toThrow(
      /category must be one of/,
    );
    await expect(upload({ expiresOn: "2026/01/01" })).rejects.toThrow(
      /YYYY-MM-DD/,
    );
    await expect(upload({ folderId: randomUUID() })).rejects.toThrow(
      /Folder not found/,
    );

    // Tags were de-duplicated; folder doc_count reflects the upload.
    const folders = await controller.listFolders(claims);
    expect(
      folders.find((r: { id: string }) => r.id === root).doc_count,
    ).toBe(1);
  });

  it("edits metadata without re-uploading bytes (move + retag + recategorize)", async () => {
    const before = await controller.list(claims, undefined, undefined, root);
    const sizeBefore = before[0].size_bytes;

    const updated = await controller.updateDocument(claims, docId, {
      folderId: child,
      category: "certificate",
      tags: "renewed, kra",
      name: "MSA-v2.pdf",
      expiresOn: daysFromNow(5),
    });
    expect(updated.category).toBe("certificate");
    expect(updated.folder_id).toBe(child);
    expect(updated.tags).toEqual(["renewed", "kra"]);
    expect(updated.name).toBe("MSA-v2.pdf");

    // Bytes untouched: still one row, same size, still downloadable size.
    const after = await controller.list(claims, undefined, undefined, child);
    expect(after).toHaveLength(1);
    expect(after[0].size_bytes).toBe(sizeBefore);

    await expect(
      controller.updateDocument(claims, docId, {}),
    ).rejects.toThrow(/Nothing to update/);
    await expect(
      controller.updateDocument(claims, docId, { name: " " }),
    ).rejects.toThrow(/cannot be empty/);
  });

  it("filters the list by folder, category, tag and q", async () => {
    // Add a second doc in root for contrast.
    await upload({
      name: "Receipt-Jan.pdf",
      folderId: root,
      category: "receipt",
      tags: ["petty-cash"],
      description: "January fuel receipt",
    });

    const inChild = await controller.list(claims, undefined, undefined, child);
    expect(inChild).toHaveLength(1);
    expect(inChild[0].id).toBe(docId);

    const rootOnly = await controller.list(claims, undefined, undefined, "root");
    expect(rootOnly.every((d: { folder_id: string | null }) => d.folder_id === null)).toBe(true);

    const byCat = await controller.list(
      claims, undefined, undefined, undefined, "receipt",
    );
    expect(byCat).toHaveLength(1);
    expect(byCat[0].category).toBe("receipt");

    const byTag = await controller.list(
      claims, undefined, undefined, undefined, undefined, "petty-cash",
    );
    expect(byTag).toHaveLength(1);

    const byQ = await controller.list(
      claims, undefined, undefined, undefined, undefined, undefined, "fuel",
    );
    expect(byQ).toHaveLength(1);
    expect(byQ[0].description).toMatch(/fuel/);

    await expect(
      controller.list(claims, undefined, undefined, undefined, "nope"),
    ).rejects.toThrow(/Unknown category/);
  });

  it("surfaces expiring documents and a category summary", async () => {
    // docId now expires in 5 days.
    const soon = await controller.expiring(claims, "30");
    const mine = soon.find((r: { id: string }) => r.id === docId);
    expect(mine).toBeTruthy();
    expect(mine.days_left).toBeLessThanOrEqual(30);

    const tight = await controller.expiring(claims, "3");
    expect(tight.find((r: { id: string }) => r.id === docId)).toBeFalsy();

    const listExpiring = await controller.list(
      claims, undefined, undefined, undefined, undefined, undefined, undefined, "30",
    );
    expect(listExpiring.some((d: { id: string }) => d.id === docId)).toBe(true);

    const s = await controller.summary(claims);
    expect(s.total_docs).toBe(2);
    expect(s.total_bytes).toBeGreaterThan(0);
    expect(s.expiring_soon).toBeGreaterThanOrEqual(1);
    const cert = s.by_category.find((c: { category: string }) => c.category === "certificate");
    expect(cert.n).toBe(1);
  });

  it("deletes folders only when empty", async () => {
    // child holds docId → cannot delete.
    await expect(controller.removeFolder(claims, child)).rejects.toThrow(
      /not empty/,
    );
    // root has a child folder → cannot delete either.
    await expect(controller.removeFolder(claims, root)).rejects.toThrow(
      /not empty/,
    );

    // Empty a fresh folder and delete it cleanly.
    const empty = await controller.createFolder(claims, { name: "Temp" });
    const gone = await controller.removeFolder(claims, empty.id);
    expect(gone.deleted).toBe(true);
    await expect(controller.removeFolder(claims, empty.id)).rejects.toThrow(
      /not found/,
    );
  });
});
