// @vitest-environment jsdom
import { fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup } from '@testing-library/react';

afterEach(() => {
  cleanup();
});

import { AvatarMenu } from '../../src/components/AvatarMenu';
import { I18nProvider } from '../../src/i18n';
import type { AgentInfo, AppConfig, ProviderModelOption } from '../../src/types';

const agents: AgentInfo[] = [
  {
    id: 'codex',
    name: 'Codex CLI',
    bin: 'codex',
    available: true,
    version: '1.0.0',
    models: [
      { id: 'gpt-5.4', label: 'gpt-5.4' },
      { id: 'gpt-5.4-mini', label: 'gpt-5.4-mini' },
      { id: 'gpt-5.5', label: 'gpt-5.5' },
      { id: 'o3', label: 'o3' },
      { id: 'o4-mini', label: 'o4-mini' },
      { id: 'deepseek-v3.2', label: 'deepseek-v3.2' },
      { id: 'deepseek-v4-flash', label: 'deepseek-v4-flash' },
      { id: 'glm-5', label: 'glm-5' },
      { id: 'qwen3-235b', label: 'qwen3-235b' },
    ],
  },
];

const daemonConfig: AppConfig = {
  mode: 'daemon',
  apiProtocol: 'openai',
  apiKey: '',
  baseUrl: '',
  apiVersion: '',
  model: '',
  byokImageModel: '',
  agentId: 'codex',
  skillId: null,
  designSystemId: null,
  agentModels: { codex: { model: 'gpt-5.4' } },
};


const byokConfig: AppConfig = {
  ...daemonConfig,
  mode: 'api',
  apiProtocol: 'openai',
  apiKey: 'sk-test',
  baseUrl: 'https://api.openai.com/v1',
  model: 'gpt-5.5',
};

const byokModelsCache: Record<string, ProviderModelOption[]> = {
  ['openai\nhttps://api.openai.com/v1\nsk-test\n']: [
    { id: 'gpt-5.5', label: 'gpt-5.5' },
    { id: 'gpt-5.4', label: 'gpt-5.4' },
    { id: 'gpt-5.4-mini', label: 'gpt-5.4-mini' },
    { id: 'gpt-image-2', label: 'gpt-image-2' },
    { id: 'o3', label: 'o3' },
    { id: 'o4-mini', label: 'o4-mini' },
    { id: 'deepseek-v3.2', label: 'deepseek-v3.2' },
    { id: 'deepseek-v4-flash', label: 'deepseek-v4-flash' },
    { id: 'glm-5', label: 'glm-5' },
  ],
};

describe('AvatarMenu', () => {

  it('fetches BYOK models on demand in project detail when no shared catalog is present', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url === '/api/provider/models') {
        return new Response(JSON.stringify({
          ok: true,
          kind: 'success',
          latencyMs: 12,
          models: [
            { id: 'gpt-4o', label: 'gpt-4o' },
            { id: 'gpt-5.5', label: 'gpt-5.5' },
          ],
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    render(
      <I18nProvider>
        <AvatarMenu
          config={{ ...byokConfig, model: 'gpt-4o' }}
          agents={agents}
          daemonLive
          onModeChange={vi.fn()}
          onAgentChange={vi.fn()}
          onAgentModelChange={vi.fn()}
          onApiModelChange={vi.fn()}
          onOpenSettings={vi.fn()}
          onRefreshAgents={vi.fn()}
          providerModelsCache={{}}
        />
      </I18nProvider>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Account & settings' }));
    await screen.findByRole('combobox', { name: 'Model' });
    await vi.waitFor(() => {
      expect(fetchMock).toHaveBeenCalled();
    });
  });

  it('lets project detail BYOK mode search and switch models from the shared provider catalog', async () => {
    const onApiModelChange = vi.fn();
    render(
      <I18nProvider>
        <AvatarMenu
          config={byokConfig}
          agents={agents}
          daemonLive
          onModeChange={vi.fn()}
          onAgentChange={vi.fn()}
          onAgentModelChange={vi.fn()}
          onApiModelChange={onApiModelChange}
          onOpenSettings={vi.fn()}
          onRefreshAgents={vi.fn()}
          providerModelsCache={byokModelsCache}
        />
      </I18nProvider>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Account & settings' }));
    const modelCombobox = await screen.findByRole('combobox', { name: 'Model' });
    expect(modelCombobox.textContent?.trim()).toBe('gpt-5.5');

    fireEvent.click(modelCombobox);
    const popover = await screen.findByTestId('avatar-byok-model-popover');
    const search = within(popover).getByTestId('avatar-byok-model-search');
    fireEvent.change(search, { target: { value: 'image' } });

    const option = within(popover).getByRole('option', { name: 'gpt-image-2' });
    fireEvent.mouseDown(option);
    fireEvent.click(option);
    expect(onApiModelChange).toHaveBeenCalledWith('gpt-image-2');
  });


  it('still shows search for shorter Local CLI catalogs such as Claude fallback models', async () => {
    const claudeAgents: AgentInfo[] = [
      {
        id: 'claude',
        name: 'Claude Code',
        bin: 'claude',
        available: true,
        version: '1.0.0',
        models: [
          { id: 'default', label: 'Default (CLI config)' },
          { id: 'sonnet', label: 'Sonnet (alias)' },
          { id: 'opus', label: 'Opus (alias)' },
          { id: 'haiku', label: 'Haiku (alias)' },
          { id: 'claude-opus-4-5', label: 'claude-opus-4-5' },
          { id: 'claude-sonnet-4-5', label: 'claude-sonnet-4-5' },
          { id: 'claude-haiku-4-5', label: 'claude-haiku-4-5' },
        ],
      },
    ];

    render(
      <I18nProvider>
        <AvatarMenu
          config={{ ...daemonConfig, agentId: 'claude', agentModels: { claude: { model: 'claude-sonnet-4-5' } } }}
          agents={claudeAgents}
          daemonLive
          onModeChange={vi.fn()}
          onAgentChange={vi.fn()}
          onAgentModelChange={vi.fn()}
          onApiModelChange={vi.fn()}
          onOpenSettings={vi.fn()}
          providerModelsCache={{}}
          onRefreshAgents={vi.fn()}
        />
      </I18nProvider>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Account & settings' }));
    const modelCombobox = await screen.findByRole('combobox', { name: 'Model' });
    fireEvent.click(modelCombobox);
    const popover = await screen.findByTestId('avatar-model-popover');
    expect(within(popover).getByTestId('avatar-model-search')).toBeTruthy();
  });

  it('uses a searchable model dropdown for the active Local CLI model picker', async () => {
    render(
      <I18nProvider>
        <AvatarMenu
          config={daemonConfig}
          agents={agents}
          daemonLive
          onModeChange={vi.fn()}
          onAgentChange={vi.fn()}
          onAgentModelChange={vi.fn()}
          onApiModelChange={vi.fn()}
          onOpenSettings={vi.fn()}
          providerModelsCache={{}}
          onRefreshAgents={vi.fn()}
        />
      </I18nProvider>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Account & settings' }));
    const modelCombobox = await screen.findByRole('combobox', { name: 'Model' });
    expect(modelCombobox.className).toContain('inline-switcher__select');

    fireEvent.click(modelCombobox);
    const popover = await screen.findByTestId('avatar-model-popover');
    const search = within(popover).getByTestId('avatar-model-search');
    fireEvent.change(search, { target: { value: 'deepseek' } });

    expect(within(popover).getByRole('option', { name: 'deepseek-v4-flash' })).toBeTruthy();
    expect(within(popover).queryByRole('option', { name: 'gpt-5.4-mini' })).toBeNull();
  });

  it('keeps the project-detail menu open long enough for Local CLI model clicks to apply', async () => {
    const onAgentModelChange = vi.fn();
    render(
      <I18nProvider>
        <AvatarMenu
          config={daemonConfig}
          agents={agents}
          daemonLive
          onModeChange={vi.fn()}
          onAgentChange={vi.fn()}
          onAgentModelChange={onAgentModelChange}
          onApiModelChange={vi.fn()}
          onOpenSettings={vi.fn()}
          providerModelsCache={{}}
          onRefreshAgents={vi.fn()}
        />
      </I18nProvider>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Account & settings' }));
    const modelCombobox = await screen.findByRole('combobox', { name: 'Model' });
    fireEvent.click(modelCombobox);
    const popover = await screen.findByTestId('avatar-model-popover');
    const option = within(popover).getByRole('option', { name: 'deepseek-v4-flash' });
    fireEvent.mouseDown(option);
    fireEvent.click(option);

    expect(onAgentModelChange).toHaveBeenCalledWith('codex', { model: 'deepseek-v4-flash' });
  });
  it('closes only the nested Local CLI model popover on Escape and keeps the avatar menu open', async () => {
    render(
      <I18nProvider>
        <AvatarMenu
          config={daemonConfig}
          agents={agents}
          daemonLive
          onModeChange={vi.fn()}
          onAgentChange={vi.fn()}
          onAgentModelChange={vi.fn()}
          onApiModelChange={vi.fn()}
          onOpenSettings={vi.fn()}
          providerModelsCache={{}}
          onRefreshAgents={vi.fn()}
        />
      </I18nProvider>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Account & settings' }));
    const menu = await screen.findByRole('dialog', { name: 'Account & settings' });
    const modelCombobox = within(menu).getByRole('combobox', { name: 'Model' });
    fireEvent.click(modelCombobox);

    const modelPopover = await screen.findByTestId('avatar-model-popover');
    const search = within(modelPopover).getByTestId('avatar-model-search');
    fireEvent.keyDown(search, { key: 'Escape' });

    await vi.waitFor(() => {
      expect(screen.queryByTestId('avatar-model-popover')).toBeNull();
    });
    expect(screen.getByRole('dialog', { name: 'Account & settings' })).toBeTruthy();
  });

});
