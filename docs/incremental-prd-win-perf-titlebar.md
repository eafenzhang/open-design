# Open Design Windows 客户端 — 增量 PRD

> **作者**: Alice (Product Manager)
> **日期**: 2025-06-24
> **版本**: v1.0
> **类型**: 增量 PRD（基于 v1.0 已有优化）
> **背景**: 前一版本已完成代码签名、GPU 加速、IPC 心跳、启动状态机、冷启动优化

---

## 需求 1：Windows 版本运行时卡顿优化

### 1.1 问题分析

#### 卡顿现象归类

| 卡顿类型 | 用户感知 | 当前项目可能根因 |
|----------|---------|-----------------|
| **UI 交互卡顿** | 点击延迟、滚动不流畅、动画掉帧 | 渲染帧率低、主进程阻塞、Next.js 路由切换重渲染 |
| **数据加载卡顿** | 列表/画布内容加载缓慢、"转圈"时间长 | IPC 数据传输延迟、daemon 处理耗时、SQLite 查询未优化 |
| **内存型卡顿** | 使用一段时间后越来越卡、长时间运行变慢 | 内存泄漏、GC 频繁触发、未释放的监听器/定时器 |
| **启动后卡顿** | 启动完成后首屏操作不流畅 | 延迟加载模块（遥测/插件）与用户操作争抢资源 |

#### 根因详细分析

**根因 A：渲染帧率无监测、无保障**

当前 GPU 检测仅做"开关"控制（white/grey/black），缺少运行时帧率监测。即使正确启用了 GPU 加速，如果：
- BrowserWindow 的 `backgroundThrottling` 默认开启导致非激活窗口降帧
- Chromium 在 Windows 上的 vsync 策略未优化
- Next.js 的 React 水合（hydration）可能触发不必要的重渲染

用户仍会感知到"卡"。

**根因 B：主进程事件循环阻塞**

当前 `index.ts` 和 `launcher-runtime.ts` 中，启动期间的 SQLite warmup、Defender exclusion 等操作虽标记 non-critical，但未做真正的非阻塞处理。此外：
- `cold-start-optimizer.ts` 的 `warmupSQLite()` 是同步等待的 async 操作
- 文件 I/O 通过 `path-utils.ts` 路径规范化，但未考虑大文件操作的流式处理
- 缺少 Event Loop Lag 监控

**根因 C：IPC 数据传输开销**

当前 IPC 侧重连接稳定性（心跳/重连），但忽略吞吐量：
- daemon ↔ renderer 之间的数据如果未经压缩/分块，大 payload 会阻塞 IPC 通道
- 主进程 ↔ renderer 的 `ipcMain.handle()` / `ipcRenderer.invoke()` 双向序列化为 JSON，大对象开销显著
- 没有 IPC 延迟指标采集

**根因 D：内存与 GC 压力**

- 当前项目没有内存监控（`process.memoryUsage()` 或 Chromium `performance.memory`）
- 长时间运行后，renderer 进程的 DOM 节点、React 组件树可能积累未回收内存
- 主进程中的 EventEmitter listener 可能未及时移除（如 `IpcHeartbeat` 设置了 `setMaxListeners(20)`，暗示预期 listener 数偏高）

**根因 E：`backgroundThrottling` 默认行为**

Electron 默认 `backgroundThrottling: true`，当用户切换到其他窗口时会将渲染帧率降到极低。这对设计工具影响尤其大——用户可能需要在两个窗口间频繁切换。

### 1.2 用户故事

**US1**: 作为设计师，我在画布上进行缩放和拖拽操作时，希望操作流畅跟手（>30fps），这样我才能精确控制设计元素。

**US2**: 作为 Windows 用户，我在使用 Open Design 超过 2 小时后，不希望应用变得越来越卡或内存占用过高，影响其他应用的正常使用。

**US3**: 作为多窗口用户，我在 Open Design 和其他应用之间切换时，希望回到 Open Design 窗口后立即恢复流畅状态，不要有"唤醒延迟"。

### 1.3 需求规格

#### P0（必须实现，阻塞发布）

| ID | 需求 | 说明 |
|----|------|------|
| **P0-1** | **渲染帧率监测与诊断** | 在 renderer 进程中实现 FPS 计数器（基于 `requestAnimationFrame`），输出到 DevTools console；在 `chrome://tracing` 兼容的格式下记录帧时间线。目标：可量化定位卡顿场景 |
| **P0-2** | **禁用 backgroundThrottling** | 在 `BrowserWindow` 的 `webPreferences` 中设置 `backgroundThrottling: false`，消除窗口切换后的"唤醒延迟" |
| **P0-3** | **主进程 Event Loop Lag 监控** | 利用 `process.hrtime()` 定时采样主进程事件循环延迟，超过阈值（如 50ms）时输出 Warning 日志，辅助定位阻塞源 |
| **P0-4** | **SQLite warmup 异步化** | 将 `cold-start-optimizer.ts` 的 `warmupSQLite()` 改写为真正的异步执行（使用 Worker Threads 或 `setImmediate` 分片），避免阻塞启动路径上的事件循环 |

#### P1（应该实现，影响核心体验）

| ID | 需求 | 说明 |
|----|------|------|
| **P1-1** | **渲染帧率阈值告警** | 在 FPS 持续低于阈值（如 24fps 超过 5s）时触发 `chrome://tracing` 录制，生成诊断报告供用户/开发者分析 |
| **P1-2** | **IPC 数据压缩/分块** | 对 >64KB 的 IPC payload 自动启用压缩（如 `permessage-deflate` 或 gzip），大于 1MB 时进行分块传输，避免阻塞 IPC 通道 |
| **P1-3** | **Next.js 路由预加载 + 组件懒加载** | 对非首屏页面启用 `next/dynamic` 懒加载；首屏路由使用 `prefetch`；对画布组件使用 React.memo + 虚拟化 |
| **P1-4** | **内存泄漏防护** | 在 `app.on('before-quit')` 中强制清理所有 EventEmitter listener；对 `IpcHeartbeat`、`SidecarManager` 添加 `dispose()` 方法；实现 renderer 进程的内存增长监控（每 30s 采样） |

#### P2（可以实现，锦上添花）

| ID | 需求 | 说明 |
|----|------|------|
| **P2-1** | **Windows 11 窗口圆角适配** | 检测 Windows 11 环境（`os.version`），使用 `BrowserWindow` 的 `roundedCorners` 选项适配系统级别的圆角 |
| **P2-2** | **CPU 优先级优化** | 在启动后通过 `process.setPriority()` 适度降低非关键线程的 CPU 优先级 |
| **P2-3** | **虚拟机/低配机器自动降级** | 检测 CPU 核心数和内存大小，自动降低渲染分辨率或动画帧率 |

---

## 需求 2：自定义标题栏

### 2.1 问题分析

#### 现状

当前 Windows 版本使用 Electron 默认的系统原生标题栏（`frame: true`，默认值）。这导致：

- **视觉割裂**：Windows 11 默认使用白色/灰色标题栏，与深色主题的 Open Design 设计界面形成明显的色块分割
- **空间浪费**：原生标题栏高度约 32px（Win10）/ 36px（Win11），占据不可用的垂直空间
- **无法定制**：无法在标题区域添加自定义控件（如搜索框、项目名称、协作状态指示器）
- **与竞品差距**：Figma、VS Code、Discord 等主流 Electron 应用均已实现自定义标题栏

#### 为什么用 `frame: false` + 自绘

这是 Electron 社区的成熟方案，VS Code、Figma、Discord、Slack 均采用此方案：

1. 设置 `frame: false` 移除系统标题栏，窗口由 Electron 的透明区域 + HTML/CSS 内容构成
2. 在 renderer 顶部绘制一个约 32-36px 的可拖拽区域，包含窗口控制按钮
3. 通过 Electron IPC 调用 `BrowserWindow` 的 `minimize()` / `maximize()` / `close()` 方法

#### 需要解决的兼容性问题

| 特性 | 原生标题栏 | 自定义标题栏 | 解决方案 |
|------|-----------|-------------|---------|
| Aero Snap | ✅ 自动 | ❌ 需手动 | `frame: false` 不影响 `BrowserWindow` 的 Aero Snap 行为，无需额外处理 |
| 窗口阴影 | ✅ 自动 | ⚠️ 可能丢失 | Electron >= 33 在 `frame: false` 下保留 DWM 阴影；在 Windows 10 需确认 |
| 任务栏缩略图 | ✅ 自动 | ✅ 自动 | 任务栏缩略图由 DWM 管理，不受 `frame: false` 影响 |
| 系统菜单 | ✅ 右键标题栏 | ❌ 需手动 | 监听标题栏区域的 `contextmenu` 事件，弹出系统菜单 |
| DPI 缩放 | ✅ 自动 | ⚠️ 需确认 | button 图标使用 SVG，尺寸基于 `devicePixelRatio` 动态计算 |
| Win11 Snap Layouts | ✅ 自动 | ⚠️ 需确认 | 鼠标悬停最大化按钮时需触发 Snap Layouts（Electron 33 部分支持） |

### 2.2 用户故事

**US4**: 作为设计师，我希望窗口标题栏与设计界面融为一体，消除视觉分割线，给我一个沉浸式的创作空间，就像 Figma 桌面端那样。

**US5**: 作为 Windows 11 用户，我希望自定义标题栏符合 Windows 11 的视觉风格（如圆角、Mica 材质），最大化/最小化按钮悬停时应有 Snap Layouts 提示，就像原生应用一样。

**US6**: 作为触屏设备用户（Surface 等），我希望标题栏的拖拽区域足够大（至少 32px 高），最大化按钮容易点击，不会误触内容区域。

### 2.3 需求规格

#### P0（必须实现，阻塞发布）

| ID | 需求 | 说明 |
|----|------|------|
| **P0-5** | **`frame: false` + 自绘标题栏** | 主窗口设置 `frame: false`，在 renderer 顶部渲染 32px（Win10）/ 36px（Win11）高的标题栏区域，包含：应用图标 + 窗口标题 + 最小化/最大化/关闭按钮 |
| **P0-6** | **窗口拖拽** | 标题栏区域设置 `-webkit-app-region: drag`，按钮区域设置 `-webkit-app-region: no-drag` |
| **P0-7** | **窗口控制按钮** | 最小化/最大化/关闭按钮调用 `BrowserWindow` IPC 方法；按钮需有 hover/active 视觉反馈，关闭按钮 hover 时使用红色背景（Windows 惯例） |
| **P0-8** | **系统菜单** | 右键标题栏（非按钮区域）弹出系统菜单（还原/移动/大小/最小化/最大化/关闭）；左键图标弹出相同菜单 |

#### P1（应该实现，影响核心体验）

| ID | 需求 | 说明 |
|----|------|------|
| **P1-5** | **Windows 11 视觉适配** | 检测 Windows 11：按钮圆角化、支持 Snap Layouts hover 触发；按钮间距调整为 Win11 风格 |
| **P1-6** | **Dark/Light 主题跟随** | 标题栏背景色跟随系统主题（通过 `nativeTheme.themeSource` 或 Windows `AppsUseLightTheme` 注册表检测），按钮颜色对应适配 |
| **P1-7** | **Mica/亚克力材质标题栏** | Windows 11 下标题栏使用 Mica 材质（通过 Electron `prefered-color-scheme` + CSS `backdrop-filter` 近似，或使用 `BrowserWindow.setBackgroundMaterial('mica')`） |
| **P1-8** | **最大化状态适配** | 最大化窗口时切换按钮图标为"还原"图标；标题栏在最大化时自动调整拖拽行为（移除顶部可拖拽区域以避免与 Aero Snap 冲突） |

#### P2（可以实现，锦上添花）

| ID | 需求 | 说明 |
|----|------|------|
| **P2-4** | **标题栏自定义控件区** | 在标题中央或左侧预留可定制的控件插槽（如项目名称显示、协作状态指示器），通过 props/slots 注入 |
| **P2-5** | **触摸优化** | 检测 `navigator.maxTouchPoints`，在触屏设备上将标题栏高度增至 44px，按钮间距增大 |
| **P2-6** | **自定义标题栏动画** | 最小化/最大化切换时添加平滑过渡动画（仿原生效果） |

### 2.4 UI 设计稿

#### 布局规格

```
┌─────────────────────────────────────────────────────────────────────┐
│ ┌─────┐                                          ┌─────┬─────┬─────┐│
│ │ ico │  Open Design — 未命名项目                  │  ─  │  □  │  ✕  ││
│ └─────┘                                          └─────┴─────┴─────┘│
│ ← drag region (32/36px) →     ← custom slot →    ← window controls →│
│                                                                     │
│ ┌─────────────────────────────────────────────────────────────────┐ │
│ │                                                                 │ │
│ │                        内容区域                                  │ │
│ │                                                                 │ │
```

- 高度: 32px (Win10) / 36px (Win11)
- 拖拽区域: 标题栏整体 (`-webkit-app-region: drag`)
- 按钮区域: `-webkit-app-region: no-drag`
- 图标: 16×16px，左侧 margin 12px
- 标题文字: 14px，图标右侧 8px 间距

#### 组件清单

| 组件名 | 文件路径建议 | 描述 |
|--------|------------|------|
| `TitleBar` | `apps/web/components/title-bar/title-bar.tsx` | 标题栏容器，管理窗口状态（normal/maximized/focused） |
| `TitleBarIcon` | `apps/web/components/title-bar/title-bar-icon.tsx` | 应用图标 + 右键菜单触发器 |
| `TitleBarTitle` | `apps/web/components/title-bar/title-bar-title.tsx` | 窗口标题文本，支持自定义 slot |
| `TitleBarControls` | `apps/web/components/title-bar/title-bar-controls.tsx` | 窗口控制按钮组容器 |
| `TitleBarButton` | `apps/web/components/title-bar/title-bar-button.tsx` | 单个窗口控制按钮（min/max/close） |

#### 按钮交互状态

| 按钮 | Normal | Hover | Active | Disabled |
|------|--------|-------|--------|----------|
| **最小化** | 透明背景, #999 图标 | #e0e0e0(dark: #3a3a3a) 背景 | #ccc(dark: #555) 背景 | 不可禁用 |
| **最大化** | 透明背景, #999 图标 | #e0e0e0(dark: #3a3a3a) 背景 | #ccc(dark: #555) 背景 | 不可禁用 |
| **还原** | 同最大化 | 同最大化 | 同最大化 | 不可禁用 |
| **关闭** | 透明背景, #999 图标 | **#e81123 红色背景, #fff 图标** | #bf0f1b 深红背景, #fff 图标 | 不可禁用 |

图标：使用 SVG `#currentColor`，按钮尺寸 46×32px（Win10）/ 48×36px（Win11）。

#### 窗口状态流转

```
NORMAL ──[最大化按钮]──▶ MAXIMIZED ──[还原按钮]──▶ NORMAL
  │                        │
  └──[双击标题栏]──▶ MAXIMIZED ──[双击标题栏]──▶ NORMAL
  │
  └──[Aero Snap 拖拽到顶部]──▶ MAXIMIZED
  │
  └──[Aero Snap 拖拽到侧边]──▶ SNAPPED (half-screen)
```

### 2.5 技术约束

- **不引入额外 UI 库**（如 MUI 的 AppBar），使用 `inline-flex` + CSS 实现
- **图标使用 SVG inline**，不依赖外部图标字体
- **窗口 API 通信**: 通过 `contextBridge` 暴露 `window.electronAPI.windowControl.minimize()` / `.maximize()` / `.close()` / `.isMaximized()`
- **`BrowserWindow` 配置新增**:
  ```typescript
  {
    frame: false,
    autoHideMenuBar: true,
    ...(isWindows11 ? { backgroundMaterial: 'mica' } : {}),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
    }
  }
  ```

---

## 待确认问题

| # | 问题 | 影响范围 | 建议 |
|---|------|---------|------|
| **Q1** | 自定义标题栏是否必须支持 Windows 10 旧版风格，还是仅 Windows 11？ | P1-5、P1-7 | 建议：Win10 用简洁风格（无 Mica），Win11 用完整适配 |
| **Q2** | 渲染性能诊断工具是内置常驻（增加 <5% CPU）还是仅 Debug 模式下启用？ | P0-1、P1-1 | 建议：Debug 模式常驻，Release 按需开启（设置面板中的开关） |
| **Q3** | IPC 压缩是默认开启还是按 payload 大小自动切换？小 payload 压缩可能得不偿失 | P1-2 | 建议：>64KB 自动启用 gzip |
| **Q4** | `backgroundThrottling: false` 会增加待机功耗，是否接受？ | P0-2 | 建议：接受。设计工具高频切换窗口是常态，功耗换取体验是合理 trade-off |
| **Q5** | Mica 材质在 `frame: false` 下是否稳定？（Electron 33 的已知限制） | P1-7 | 建议：先做 feature detection，不可用时降级为纯色背景 |
| **Q6** | 标题栏左侧是否需要展示项目名称/文件路径？ | P2-4 | 建议：首版仅显示"Open Design — 项目名"，后续通过 slot 扩展 |

---

## 文件变更预估

### 新建文件

| 文件路径 | 用途 |
|---------|------|
| `apps/web/components/title-bar/title-bar.tsx` | 标题栏容器组件 |
| `apps/web/components/title-bar/title-bar-controls.tsx` | 窗口控制按钮组 |
| `apps/web/components/title-bar/title-bar-button.tsx` | 单个按钮组件 |
| `apps/web/components/title-bar/title-bar-icon.tsx` | 应用图标组件 |
| `apps/web/components/title-bar/title-bar-title.tsx` | 标题文本组件 |
| `apps/packaged/src/performance-monitor.ts` | FPS 监测 + Event Loop Lag 监测 |
| `apps/packaged/src/ipc-compression.ts` | IPC payload 压缩/分块 |
| `apps/packaged/src/types/performance-metrics.ts` | 性能指标类型定义 |

### 修改文件

| 文件路径 | 修改内容 |
|---------|---------|
| `apps/packaged/src/index.ts` | `BrowserWindow` 新增 `frame: false`；集成 PerformanceMonitor |
| `apps/packaged/src/cold-start-optimizer.ts` | `warmupSQLite()` 异步化（Worker Threads） |
| `apps/packaged/src/windows-lifecycle.ts` | 新增 PERF_MONITORING 生命周期 hook |
| `apps/packaged/src/types/startup-state.ts` | 可选：新增 `PERFORMANCE_READY` 状态 |
| `apps/desktop/electron-builder.config.ts` | 无需修改（标题栏是运行时行为） |

---

> **文档结束** — 请 Team Lead 审核后指派架构师设计实现方案。
