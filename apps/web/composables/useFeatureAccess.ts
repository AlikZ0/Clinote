/**
 * Single entry point for "can this user do this?" (product spec §45).
 *
 * Components ask for a feature, never for a plan id. The entitlement comes from
 * the server once accounts exist (Phase 7); until then it is the anonymous Free
 * snapshot, which is also the correct fail-closed default for a logged-out or
 * offline client.
 */
import {
  ANONYMOUS_ENTITLEMENT,
  DEFAULT_PLANS,
  FeatureAccessService,
  findPlan,
} from '@clinote/config'
import type { Entitlement, FeatureFlag, LimitKey } from '@clinote/types'
import { getLocalCore } from '~/database'

/**
 * Development affordance: lets a plan be simulated on this device so paid
 * screens can be built and reviewed before billing exists.
 *
 * It is deliberately visible in the UI and deliberately powerless: it only
 * applies while no server entitlement has been received, and every paid route
 * is re-checked server-side (docs/subscriptions.md §1). It can grant a screen,
 * never a capability.
 */
const PREVIEW_PLAN_SETTING = 'dev.previewPlan'

export function useFeatureAccess() {
  const entitlement = useState<Entitlement>('entitlement', () => ANONYMOUS_ENTITLEMENT)
  const previewPlanId = useState<string | null>('entitlement.preview', () => null)
  /** Set once a real entitlement arrives from the API; the preview then stops applying. */
  const fromServer = useState('entitlement.fromServer', () => false)

  const service = computed(() => new FeatureAccessService(entitlement.value))

  async function loadPreviewPlan(): Promise<void> {
    if (fromServer.value) return
    try {
      const core = await getLocalCore()
      const planId = await core.settings.get<string | null>(PREVIEW_PLAN_SETTING, null)
      applyPreview(planId)
    } catch {
      // No database yet: Free is the right answer.
    }
  }

  async function setPreviewPlan(planId: string | null): Promise<void> {
    applyPreview(planId)
    try {
      const core = await getLocalCore()
      if (planId) await core.settings.set(PREVIEW_PLAN_SETTING, planId)
      else await core.settings.remove(PREVIEW_PLAN_SETTING)
    } catch {
      // The preview is a convenience; failing to persist it is not an error.
    }
  }

  function applyPreview(planId: string | null): void {
    previewPlanId.value = planId
    const plan = planId ? findPlan(DEFAULT_PLANS, planId) : undefined
    entitlement.value = plan
      ? {
          planId: plan.id,
          status: 'active',
          features: plan.features,
          limits: plan.limits,
          usage: { storageBytes: 0, devices: 0, members: 0 },
          expiresAt: null,
        }
      : ANONYMOUS_ENTITLEMENT
  }

  function setEntitlement(next: Entitlement): void {
    fromServer.value = true
    previewPlanId.value = null
    entitlement.value = next
  }

  return {
    entitlement,
    previewPlanId,
    isPreview: computed(() => previewPlanId.value !== null && !fromServer.value),
    planId: computed(() => entitlement.value.planId),
    canUse: (feature: FeatureFlag) => service.value.canUse(feature),
    limit: (key: LimitKey) => service.value.limit(key),
    loadPreviewPlan,
    setPreviewPlan,
    setEntitlement,
  }
}
