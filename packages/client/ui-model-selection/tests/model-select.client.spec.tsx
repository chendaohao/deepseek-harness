// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ModelSelection } from '@deepseek-ai/dsh-api-remotes/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import { RECENT_MODELS_KEY, readRecentModels } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ComponentProps } from 'react'
import type { ModelDirectoryState } from '../src/client/directory.ts'
import { ModelSelect } from '../src/client/ModelSelect.tsx'
import { zh } from '../src/client/locales.ts'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'

// The seat's key domain is model ∪ common; the stub mirrors the real lookup
// chain: package dictionary, then common vocabulary, then the key.
const t: ComponentProps<typeof ModelSelect>['t'] = (key, params) => {
  const template = (zh as Record<string, string>)[key]
    ?? (commonZh as Record<string, string>)[key]
    ?? key
  return params === undefined
    ? template
    : template.replace(/\{(\w+)\}/g, (match, name: string) => name in params ? String(params[name]) : match)
}

const reasoning = {
  efforts: [
    { id: 'off', name: 'Off' },
    { id: 'high', name: 'High' },
    { id: 'max', name: 'Max', description: 'Largest budget' },
  ],
  defaultEffort: 'high',
}

function state(overrides: Partial<ModelDirectoryState> = {}): ModelDirectoryState {
  return {
    current: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
    routable: true,
    groups: [{
      id: 'deepseek-official',
      name: 'DeepSeek',
      models: [{ id: 'deepseek-v4-flash', name: 'DeepSeek-V4-Flash', reasoning }],
    }],
    failures: [],
    status: 'ready',
    error: null,
    ...overrides,
  }
}

afterEach(cleanup)
beforeEach(() => { localStorage.clear() })

describe('ModelSelect reasoning effort', () => {
  it('renders adapter metadata and submits the effort as part of the session selection', async () => {
    const directory = createSnapshotStore<ModelDirectoryState>(state())
    const select = vi.fn(async (selection: ModelSelection) => {
      directory.set(state({ current: selection }))
      return true
    })
    render(<ModelSelect
      locked={false}
      available
      directory={directory}
      load={vi.fn()}
      select={select}
      t={t}
    />)

    const trigger = screen.getByRole('button', {
      name: '选择模型，当前 DeepSeek-V4-Flash，推理等级 High',
    })
    fireEvent.click(trigger)
    fireEvent.click(screen.getByRole('menuitem', { name: /推理等级/ }))
    expect(screen.getAllByRole('menuitemradio').map(item => item.textContent))
      .toEqual(['Off', 'High', 'MaxLargest budget'])

    fireEvent.click(screen.getByRole('menuitemradio', { name: /Max/ }))
    await waitFor(() => {
      expect(select).toHaveBeenCalledWith({
        provider: 'deepseek-official',
        model: 'deepseek-v4-flash',
        reasoningEffort: 'max',
      })
      expect(trigger.getAttribute('aria-label')).toBe('选择模型，当前 DeepSeek-V4-Flash，推理等级 Max')
    })
  })

  it('offers provider default only when the adapter does not configure a model default', () => {
    const directory = createSnapshotStore(state({
      groups: [{
        id: 'provider',
        name: 'Provider',
        models: [{
          id: 'model',
          name: 'Model',
          reasoning: { efforts: [{ id: 'standard', name: 'Standard' }] },
        }],
      }],
      current: { provider: 'provider', model: 'model' },
    }))
    render(<ModelSelect
      locked={false}
      available
      directory={directory}
      load={vi.fn()}
      select={vi.fn().mockResolvedValue(true)}
      t={t}
    />)

    fireEvent.click(screen.getByRole('button', {
      name: '选择模型，当前 Model，推理等级 Default',
    }))
    fireEvent.click(screen.getByRole('menuitem', { name: /推理等级/ }))
    expect(screen.getAllByRole('menuitemradio').map(item => item.textContent))
      .toEqual(['Default', 'Standard'])
  })

  it('prompts for a selection when the current model is no longer advertised', () => {
    const directory = createSnapshotStore(state({
      current: { provider: 'deepseek-official', model: 'removed-model' },
    }))
    const select = vi.fn().mockResolvedValue(true)
    render(<ModelSelect
      locked={false}
      available
      directory={directory}
      load={vi.fn()}
      select={select}
      t={t}
    />)

    const trigger = screen.getByRole('button', { name: '选择模型' })
    expect(trigger.textContent).toContain('选择模型')
    fireEvent.click(trigger)
    expect(screen.queryByRole('menuitem', { name: /推理等级/ })).toBeNull()
    fireEvent.click(screen.getByRole('menuitem', { name: /模型/ }))
    expect(screen.queryByText('removed-model')).toBeNull()
    expect(screen.getByRole('menuitemradio', { name: 'DeepSeek-V4-Flash' })).toBeTruthy()
  })

  it('announces a rejected selection as a transient toast and keeps the in-menu strip for loads', async () => {
    const groups = [{
      id: 'deepseek-official',
      name: 'DeepSeek',
      models: [
        { id: 'deepseek-v4-flash', name: 'DeepSeek-V4-Flash', reasoning },
        { id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro' },
      ],
    }]
    const directory = createSnapshotStore<ModelDirectoryState>(state({ groups }))
    const select = vi.fn(async () => {
      directory.set(state({ groups, status: 'error', error: 'model-unavailable: session already contains images' }))
      return false
    })
    render(<ModelSelect
      locked={false}
      available
      directory={directory}
      load={vi.fn()}
      select={select}
      t={t}
    />)

    fireEvent.click(screen.getByRole('button', { name: /选择模型|当前/ }))
    fireEvent.click(screen.getByRole('menuitem', { name: /模型/ }))
    fireEvent.click(screen.getByRole('menuitemradio', { name: /DeepSeek-V4-Pro/ }))
    const toast = await screen.findByRole('alert')
    expect(toast.textContent).toContain('模型操作失败：model-unavailable: session already contains images')
    // The selection failure does not render the in-menu load strip (no Retry).
    expect(screen.queryByRole('button', { name: '重试' })).toBeNull()
  })

  it('announces a pick the host normalized to the model default as a toast', async () => {
    const directory = createSnapshotStore<ModelDirectoryState>(state())
    const select = vi.fn(async (selection: ModelSelection) => {
      // The host resolves an unsupported pick to the model's declared default.
      directory.set(state({ current: { ...selection, reasoningEffort: 'high' } }))
      return true
    })
    render(<ModelSelect
      locked={false}
      available
      directory={directory}
      load={vi.fn()}
      select={select}
      t={t}
    />)

    const trigger = screen.getByRole('button', {
      name: '选择模型，当前 DeepSeek-V4-Flash，推理等级 High',
    })
    fireEvent.click(trigger)
    fireEvent.click(screen.getByRole('menuitem', { name: /推理等级/ }))
    fireEvent.click(screen.getByRole('menuitemradio', { name: /Max/ }))
    const toast = await screen.findByRole('alert')
    expect(toast.textContent).toContain('该模型不支持所选思考等级，已回退到 High')
    // The normalized effort is what the trigger now shows.
    expect(trigger.getAttribute('aria-label')).toBe('选择模型，当前 DeepSeek-V4-Flash，推理等级 High')
  })

  it('renders no Agent-bound control for an addressed subagent session', () => {
    const load = vi.fn()
    render(<ModelSelect
      locked={false}
      available={false}
      directory={createSnapshotStore(state())}
      load={load}
      select={vi.fn().mockResolvedValue(false)}
      t={t}
    />)

    expect(screen.queryByRole('button')).toBeNull()
    expect(load).not.toHaveBeenCalled()
  })
})

const multiGroups = [
  { id: 'deepseek-official', name: 'DeepSeek', models: [
    { id: 'deepseek-v4-flash', name: 'DeepSeek-V4-Flash' },
    { id: 'deepseek-r1', name: 'DeepSeek-R1' },
  ] },
  { id: 'anthropic', name: 'Anthropic', models: [
    { id: 'claude-sonnet', name: 'Claude Sonnet' },
    { id: 'claude-opus', name: 'Claude Opus' },
  ] },
]

/** Open the trigger and drill into the model pane. */
function openModelPane(groups: ModelDirectoryState['groups'] = state().groups) {
  const directory = createSnapshotStore<ModelDirectoryState>(state({ groups }))
  const select = vi.fn().mockResolvedValue(true)
  render(<ModelSelect
    locked={false}
    available
    directory={directory}
    load={vi.fn()}
    select={select}
    t={t}
  />)
  fireEvent.click(screen.getByRole('button', { name: /选择模型|当前/ }))
  fireEvent.click(screen.getByRole('menuitem', { name: /模型/ }))
  return { directory, select }
}

describe('ModelSelect search, recently used, and collapse', () => {
  it('filters the catalog flat by model name, model id, and provider name', () => {
    openModelPane(multiGroups)
    const input = screen.getByRole('searchbox')
    fireEvent.change(input, { target: { value: 'sonnet' } })
    expect(screen.getAllByRole('menuitemradio').map(item => item.textContent))
      .toEqual(['Claude SonnetAnthropic'])
    fireEvent.change(input, { target: { value: 'deepseek-r1' } })
    expect(screen.getAllByRole('menuitemradio').map(item => item.textContent))
      .toEqual(['DeepSeek-R1DeepSeek'])
    fireEvent.change(input, { target: { value: 'anthropic' } })
    expect(screen.getAllByRole('menuitemradio')).toHaveLength(2)
  })

  it('shows an empty state when no model matches', () => {
    openModelPane(multiGroups)
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'zzz' } })
    expect(screen.getByText('没有匹配的模型。')).toBeTruthy()
    expect(screen.queryByRole('menuitemradio')).toBeNull()
  })

  it('clears the search on Escape before backing out of the pane', () => {
    openModelPane(multiGroups)
    const input = screen.getByRole('searchbox')
    fireEvent.change(input, { target: { value: 'sonnet' } })
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(screen.getByRole<HTMLInputElement>('searchbox').value).toBe('')
    // Still on the model pane: the group headers are back.
    expect(within(screen.getByRole('menu')).getByRole('button', { name: /DeepSeek/ })).toBeTruthy()
    fireEvent.keyDown(screen.getByRole('searchbox'), { key: 'Escape' })
    // Backed out to the root rows.
    expect(screen.getByRole('menuitem', { name: /模型/ })).toBeTruthy()
  })

  it('shows only catalog-present recent models and records an accepted pick', async () => {
    localStorage.setItem(RECENT_MODELS_KEY, JSON.stringify([
      { provider: 'anthropic', model: 'claude-opus' },
      { provider: 'old', model: 'gone' },
    ]))
    const { select } = openModelPane(multiGroups)
    const rows = screen.getAllByRole('menuitemradio')
    expect(rows.some(row => row.textContent?.includes('Claude Opus'))).toBe(true)
    expect(rows.some(row => row.textContent?.includes('gone'))).toBe(false)
    const pick = screen.getAllByRole('menuitemradio', { name: /Claude Opus/ })[0]!
    fireEvent.click(pick)
    await waitFor(() => {
      expect(select).toHaveBeenCalled()
      expect(readRecentModels()[0]).toEqual({ provider: 'anthropic', model: 'claude-opus' })
    })
  })

  it('collapses and expands a provider group', () => {
    openModelPane(multiGroups)
    expect(screen.getAllByRole('menuitemradio')).toHaveLength(4)
    const menu = screen.getByRole('menu')
    const deepseekToggle = within(menu).getByRole('button', { name: /DeepSeek/ })
    fireEvent.click(deepseekToggle)
    expect(screen.queryByRole('menuitemradio', { name: 'DeepSeek-V4-Flash' })).toBeNull()
    fireEvent.click(within(menu).getByRole('button', { name: /DeepSeek/ }))
    expect(screen.getByRole('menuitemradio', { name: 'DeepSeek-V4-Flash' })).toBeTruthy()
  })

  it('moves focus from the search field into the first list item on ArrowDown', () => {
    openModelPane(multiGroups)
    const input = screen.getByRole('searchbox')
    input.focus()
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    expect(document.activeElement).not.toBe(input)
    expect(document.activeElement?.tagName).toBe('BUTTON')
  })

  it('keeps arrow rotation within the options, skipping the search field', () => {
    openModelPane(multiGroups)
    const first = screen.getAllByRole('menuitemradio')[0]!
    const second = screen.getAllByRole('menuitemradio')[1]!
    first.focus()
    fireEvent.keyDown(first, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(second)
  })
})
