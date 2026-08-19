import { Router } from "express";
import { requireAdmin } from "../auth/middleware.js";
import { generateApiKey } from "../auth/apiKeys.js";
import { invalidateAllApiKeys, invalidateTenantConfig } from "../cache/configCache.js";
import { writeAudit, listAudit } from "../db/repositories/audit.js";
import { insertApiKey, listApiKeys, revokeApiKey } from "../db/repositories/apiKeys.js";
import { createPolicy, getPolicy, listPolicies, updatePolicy } from "../db/repositories/policies.js";
import { createRoute, getRoute, listRoutes, updateRoute } from "../db/repositories/routes.js";
import { createTenant, getTenantById, listTenants, updateTenant } from "../db/repositories/tenants.js";
import { createUpstream, getUpstream, listUpstreams, updateUpstream } from "../db/repositories/upstreams.js";
import { publicApiKey } from "../db/mappers.js";
import { badRequest } from "../errors.js";
import { validateDimensions } from "../policy/dimensions.js";
import {
  apiKeyCreateSchema,
  policyPatchSchema,
  policyUpsertSchema,
  routePatchSchema,
  routeUpsertSchema,
  tenantCreateSchema,
  tenantUpdateSchema,
  upstreamPatchSchema,
  upstreamUpsertSchema
} from "./schemas.js";

export const adminRouter = Router();
adminRouter.use(requireAdmin);

function parse<T>(schema: { safeParse: (value: unknown) => { success: true; data: T } | { success: false; error: { issues: unknown } } }, body: unknown): T {
  const result = schema.safeParse(body);
  if (!result.success) {
    throw badRequest("Validation failed", { issues: result.error.issues });
  }
  return result.data;
}

adminRouter.get("/tenants", async (_req, res, next) => {
  try {
    res.json({ tenants: await listTenants() });
  } catch (error) {
    next(error);
  }
});

adminRouter.post("/tenants", async (req, res, next) => {
  try {
    const body = parse(tenantCreateSchema, req.body);
    const tenant = await createTenant(body);
    await writeAudit({
      tenantId: tenant.id,
      actor: "admin",
      action: "tenant.create",
      resourceType: "tenant",
      resourceId: tenant.id,
      payload: body
    });
    res.status(201).json({ tenant });
  } catch (error) {
    next(error);
  }
});

adminRouter.get("/tenants/:tenantId", async (req, res, next) => {
  try {
    res.json({ tenant: await getTenantById(req.params.tenantId) });
  } catch (error) {
    next(error);
  }
});

adminRouter.patch("/tenants/:tenantId", async (req, res, next) => {
  try {
    const body = parse(tenantUpdateSchema, req.body);
    const tenant = await updateTenant(req.params.tenantId, body);
    invalidateTenantConfig(tenant.id);
    await writeAudit({
      tenantId: tenant.id,
      actor: "admin",
      action: "tenant.update",
      resourceType: "tenant",
      resourceId: tenant.id,
      payload: body
    });
    res.json({ tenant });
  } catch (error) {
    next(error);
  }
});

adminRouter.get("/tenants/:tenantId/api-keys", async (req, res, next) => {
  try {
    await getTenantById(req.params.tenantId);
    const keys = (await listApiKeys(req.params.tenantId)).map(publicApiKey);
    res.json({ apiKeys: keys });
  } catch (error) {
    next(error);
  }
});

adminRouter.post("/tenants/:tenantId/api-keys", async (req, res, next) => {
  try {
    await getTenantById(req.params.tenantId);
    const body = parse(apiKeyCreateSchema, req.body);
    const generated = generateApiKey();
    const record = await insertApiKey({
      tenantId: req.params.tenantId,
      name: body.name,
      keyPrefix: generated.prefix,
      keyHash: generated.hash,
      expiresAt: body.expiresAt ? new Date(body.expiresAt) : null
    });
    invalidateAllApiKeys();
    await writeAudit({
      tenantId: req.params.tenantId,
      actor: "admin",
      action: "api_key.create",
      resourceType: "api_key",
      resourceId: record.id,
      payload: { name: body.name }
    });
    res.status(201).json({ apiKey: publicApiKey(record), plaintext: generated.plaintext });
  } catch (error) {
    next(error);
  }
});

adminRouter.post("/tenants/:tenantId/api-keys/:keyId/revoke", async (req, res, next) => {
  try {
    const record = await revokeApiKey(req.params.tenantId, req.params.keyId);
    invalidateAllApiKeys();
    await writeAudit({
      tenantId: req.params.tenantId,
      actor: "admin",
      action: "api_key.revoke",
      resourceType: "api_key",
      resourceId: record.id
    });
    res.json({ apiKey: publicApiKey(record) });
  } catch (error) {
    next(error);
  }
});

adminRouter.post("/tenants/:tenantId/api-keys/:keyId/rotate", async (req, res, next) => {
  try {
    await getTenantById(req.params.tenantId);
    const generated = generateApiKey();
    const created = await insertApiKey({
      tenantId: req.params.tenantId,
      name: `${req.params.keyId}-rotated`,
      keyPrefix: generated.prefix,
      keyHash: generated.hash
    });
    const revoked = await revokeApiKey(req.params.tenantId, req.params.keyId);
    invalidateAllApiKeys();
    await writeAudit({
      tenantId: req.params.tenantId,
      actor: "admin",
      action: "api_key.rotate",
      resourceType: "api_key",
      resourceId: created.id,
      payload: { revokedId: revoked.id }
    });
    res.status(201).json({
      apiKey: publicApiKey(created),
      revoked: publicApiKey(revoked),
      plaintext: generated.plaintext
    });
  } catch (error) {
    next(error);
  }
});

adminRouter.get("/tenants/:tenantId/policies", async (req, res, next) => {
  try {
    await getTenantById(req.params.tenantId);
    res.json({ policies: await listPolicies(req.params.tenantId) });
  } catch (error) {
    next(error);
  }
});

adminRouter.post("/tenants/:tenantId/policies", async (req, res, next) => {
  try {
    await getTenantById(req.params.tenantId);
    const body = parse(policyUpsertSchema, req.body);
    const dimensionError = validateDimensions(body.dimensions);
    if (dimensionError) {
      throw badRequest(dimensionError);
    }
    const policy = await createPolicy({ ...body, tenantId: req.params.tenantId });
    invalidateTenantConfig(req.params.tenantId);
    await writeAudit({
      tenantId: req.params.tenantId,
      actor: "admin",
      action: "policy.create",
      resourceType: "policy",
      resourceId: policy.id
    });
    res.status(201).json({ policy });
  } catch (error) {
    next(error);
  }
});

adminRouter.get("/tenants/:tenantId/policies/:policyId", async (req, res, next) => {
  try {
    res.json({ policy: await getPolicy(req.params.tenantId, req.params.policyId) });
  } catch (error) {
    next(error);
  }
});

adminRouter.patch("/tenants/:tenantId/policies/:policyId", async (req, res, next) => {
  try {
    const body = parse(policyPatchSchema, req.body);
    if (body.dimensions) {
      const dimensionError = validateDimensions(body.dimensions);
      if (dimensionError) {
        throw badRequest(dimensionError);
      }
    }
    const policy = await updatePolicy(req.params.tenantId, req.params.policyId, body);
    invalidateTenantConfig(req.params.tenantId);
    await writeAudit({
      tenantId: req.params.tenantId,
      actor: "admin",
      action: "policy.update",
      resourceType: "policy",
      resourceId: policy.id
    });
    res.json({ policy });
  } catch (error) {
    next(error);
  }
});

adminRouter.get("/tenants/:tenantId/upstreams", async (req, res, next) => {
  try {
    await getTenantById(req.params.tenantId);
    res.json({ upstreams: await listUpstreams(req.params.tenantId) });
  } catch (error) {
    next(error);
  }
});

adminRouter.post("/tenants/:tenantId/upstreams", async (req, res, next) => {
  try {
    await getTenantById(req.params.tenantId);
    const body = parse(upstreamUpsertSchema, req.body);
    const upstream = await createUpstream({ ...body, tenantId: req.params.tenantId });
    invalidateTenantConfig(req.params.tenantId);
    await writeAudit({
      tenantId: req.params.tenantId,
      actor: "admin",
      action: "upstream.create",
      resourceType: "upstream",
      resourceId: upstream.id
    });
    res.status(201).json({ upstream });
  } catch (error) {
    next(error);
  }
});

adminRouter.get("/tenants/:tenantId/upstreams/:upstreamId", async (req, res, next) => {
  try {
    res.json({ upstream: await getUpstream(req.params.tenantId, req.params.upstreamId) });
  } catch (error) {
    next(error);
  }
});

adminRouter.patch("/tenants/:tenantId/upstreams/:upstreamId", async (req, res, next) => {
  try {
    const body = parse(upstreamPatchSchema, req.body);
    const upstream = await updateUpstream(req.params.tenantId, req.params.upstreamId, body);
    invalidateTenantConfig(req.params.tenantId);
    await writeAudit({
      tenantId: req.params.tenantId,
      actor: "admin",
      action: "upstream.update",
      resourceType: "upstream",
      resourceId: upstream.id
    });
    res.json({ upstream });
  } catch (error) {
    next(error);
  }
});

adminRouter.get("/tenants/:tenantId/routes", async (req, res, next) => {
  try {
    await getTenantById(req.params.tenantId);
    res.json({ routes: await listRoutes(req.params.tenantId) });
  } catch (error) {
    next(error);
  }
});

adminRouter.post("/tenants/:tenantId/routes", async (req, res, next) => {
  try {
    await getTenantById(req.params.tenantId);
    const body = parse(routeUpsertSchema, req.body);
    await getPolicy(req.params.tenantId, body.policyId);
    await getUpstream(req.params.tenantId, body.upstreamId);
    const route = await createRoute({ ...body, tenantId: req.params.tenantId });
    invalidateTenantConfig(req.params.tenantId);
    await writeAudit({
      tenantId: req.params.tenantId,
      actor: "admin",
      action: "route.create",
      resourceType: "route",
      resourceId: route.id
    });
    res.status(201).json({ route });
  } catch (error) {
    next(error);
  }
});

adminRouter.get("/tenants/:tenantId/routes/:routeId", async (req, res, next) => {
  try {
    res.json({ route: await getRoute(req.params.tenantId, req.params.routeId) });
  } catch (error) {
    next(error);
  }
});

adminRouter.patch("/tenants/:tenantId/routes/:routeId", async (req, res, next) => {
  try {
    const body = parse(routePatchSchema, req.body);
    if (body.policyId) {
      await getPolicy(req.params.tenantId, body.policyId);
    }
    if (body.upstreamId) {
      await getUpstream(req.params.tenantId, body.upstreamId);
    }
    const route = await updateRoute(req.params.tenantId, req.params.routeId, body);
    invalidateTenantConfig(req.params.tenantId);
    await writeAudit({
      tenantId: req.params.tenantId,
      actor: "admin",
      action: "route.update",
      resourceType: "route",
      resourceId: route.id
    });
    res.json({ route });
  } catch (error) {
    next(error);
  }
});

adminRouter.get("/tenants/:tenantId/audit", async (req, res, next) => {
  try {
    await getTenantById(req.params.tenantId);
    res.json({ audit: await listAudit(req.params.tenantId) });
  } catch (error) {
    next(error);
  }
});
