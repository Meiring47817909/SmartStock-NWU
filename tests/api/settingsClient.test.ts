import { beforeEach, describe, expect, it, vi } from 'vitest'

const apiMock = vi.hoisted(() => vi.fn())
vi.mock('@/lib/api/client', () => ({ api: apiMock }))

import {
  loadAdminNotificationEmail,
  loadNotificationSettings,
  loadSystemFromEmail,
  saveAdminNotificationEmail,
  saveSystemFromEmail,
  setNotificationSetting,
} from '@/lib/api/settings'

beforeEach(() => apiMock.mockReset())

describe('settings client', () => {
  it('maps the loaders onto the route', async () => {
    apiMock.mockResolvedValue({ low_stock_alert: false })
    expect(await loadNotificationSettings()).toEqual({ low_stock_alert: false })
    expect(apiMock).toHaveBeenLastCalledWith('GET', '/api/settings/notifications')

    apiMock.mockResolvedValue({ value: 'a@nwu.test' })
    expect(await loadAdminNotificationEmail()).toBe('a@nwu.test')
    expect(apiMock).toHaveBeenLastCalledWith('GET', '/api/settings/notifications', { kind: 'admin_notification_email' })
    expect(await loadSystemFromEmail()).toBe('a@nwu.test')
    expect(apiMock).toHaveBeenLastCalledWith('GET', '/api/settings/notifications', { kind: 'system_from_email' })
  })

  it('maps the saves onto the route (no actor and no previous value: the server knows both)', async () => {
    apiMock.mockResolvedValue({})
    await setNotificationSetting('low_stock_alert', false)
    expect(apiMock).toHaveBeenLastCalledWith('POST', '/api/settings/notifications', { action: 'toggle', key: 'low_stock_alert', value: false })
    await saveAdminNotificationEmail('a@nwu.test')
    expect(apiMock).toHaveBeenLastCalledWith('POST', '/api/settings/notifications', { action: 'address', field: 'admin_notification_email', value: 'a@nwu.test' })
    await saveSystemFromEmail('')
    expect(apiMock).toHaveBeenLastCalledWith('POST', '/api/settings/notifications', { action: 'address', field: 'system_from_email', value: '' })
  })

  it("a refused save rejects with the server's message so the form can show it", async () => {
    apiMock.mockRejectedValueOnce(new Error('Enter a valid email address.'))
    await expect(saveAdminNotificationEmail('nope')).rejects.toThrow('Enter a valid email address.')
  })
})
