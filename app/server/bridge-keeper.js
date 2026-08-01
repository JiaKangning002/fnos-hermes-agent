// Agent Bridge 保活模块（ESM，外接于 monitor.js）。
// 职责：bridge 子进程退出监听 + 退避自动重启 + 定期健康检查（僵死杀掉重拉）。
// 所有外部能力（启动/停止/ping/取pid/停机判定/日志/时钟）由 monitor.js 注入。

/**
 * 创建保活器
 * @param {{
 *   log: Function,                 // 日志
 *   restart: Function,             // 启动 bridge，返回 {ok, pid?, msg?, error?}
 *   stop: Function,                // 停止 bridge（async）
 *   ping: Function,                // 探活（async，成功 resolve / 失败 reject）
 *   getPid: Function,              // 当前 bridge 存活 pid（无则 null）
 *   isManualStopped: Function,     // 用户主动停机期间返回 true
 *   backoffMs?: number[],          // 重启退避序列（末项为上限）
 *   maxRestarts?: number,          // 连续自动重启上限，超过后放弃
 *   stableUptimeMs?: number,       // 存活超过该时长视为稳定运行，崩溃计数清零
 *   healthIntervalMs?: number,     // 健康检查周期
 *   pingFailThreshold?: number,    // 连续 ping 失败次数达到该值视为僵死
 *   nowFn?, setTimeoutFn?, clearTimeoutFn?, setIntervalFn?,  // 测试注入
 * }} opts
 */
export function createBridgeKeeper(opts) {
  const log = opts.log || (() => {});
  const backoffMs = opts.backoffMs || [1000, 5000, 30000, 60000];
  const maxRestarts = opts.maxRestarts ?? 10;
  const stableUptimeMs = opts.stableUptimeMs ?? 60000;
  const healthIntervalMs = opts.healthIntervalMs ?? 60000;
  const pingFailThreshold = opts.pingFailThreshold ?? 2;
  const now = opts.nowFn || Date.now;
  const setTimeoutFn = opts.setTimeoutFn || setTimeout;
  const clearTimeoutFn = opts.clearTimeoutFn || clearTimeout;
  const setIntervalFn = opts.setIntervalFn || setInterval;

  let attempts = 0;          // 连续自动重启计数（稳定运行/手动启动后清零）
  let gaveUp = false;        // 达到重启上限后置位，手动启动解除
  let restartTimer = null;   // 待执行的退避重启定时器
  let autoStartInFlight = false; // 区分保活重启与手动启动（手动启动清零计数）
  let watchedPid = null;
  let watchedStartAt = 0;
  let lastSeenPid = null;   // 健康检查见过但未 watch 的进程（monitor 重启后收养的旧 bridge）
  let pingFails = 0;
  let healthTimer = null;

  function backoffDelay(attempt) {
    return backoffMs[Math.min(attempt, backoffMs.length - 1)];
  }

  // 每次 bridge 成功 spawn 后调用：登记进程并挂退出监听
  function watch(proc, pid) {
    if (!autoStartInFlight) { attempts = 0; gaveUp = false; } // 手动启动：重置崩溃计数与放弃态
    watchedPid = pid;
    watchedStartAt = now();
    pingFails = 0;
    if (proc && proc.exited && typeof proc.exited.then === "function") {
      proc.exited.then((code) => onExit(code, pid)).catch(() => {});
    }
  }

  function onExit(code, pid) {
    if (pid !== watchedPid) return; // 旧进程的退出事件，忽略
    const uptime = now() - watchedStartAt;
    watchedPid = null;
    pingFails = 0;
    log(`[bridge] 进程退出 code=${code} uptime=${Math.round(uptime / 1000)}s`);
    if (opts.isManualStopped && opts.isManualStopped()) {
      log("[bridge] 处于手动停机状态，不自动重启");
      return;
    }
    if (uptime >= stableUptimeMs) attempts = 0; // 稳定运行后再崩溃：重新计数
    scheduleRestart(`进程退出 code=${code}`);
  }

  function scheduleRestart(reason) {
    if (gaveUp || restartTimer) return;
    if (opts.isManualStopped && opts.isManualStopped()) return;
    if (attempts >= maxRestarts) {
      gaveUp = true;
      log(`[bridge] 连续崩溃 ${attempts} 次已达上限，停止自动重启（需手动启动服务恢复）`);
      return;
    }
    const delay = backoffDelay(attempts);
    attempts++;
    log(`[bridge] ${reason}，${delay}ms 后自动重启（第 ${attempts}/${maxRestarts} 次）`);
    restartTimer = setTimeoutFn(() => {
      restartTimer = null;
      if (opts.isManualStopped && opts.isManualStopped()) {
        log("[bridge] 处于手动停机状态，取消自动重启");
        return;
      }
      let r = null;
      autoStartInFlight = true;
      try { r = opts.restart(); }
      catch (e) { r = { ok: false, error: e?.message || String(e) }; }
      finally { autoStartInFlight = false; }
      if (r && r.ok) {
        if (r.msg !== "already_running" && r.msg !== "start_in_progress") log(`[bridge] bridge 已恢复（自动重启成功${r.pid ? " pid=" + r.pid : ""}）`);
      } else {
        scheduleRestart(`自动重启失败: ${(r && r.error) || "unknown"}`);
      }
    }, delay);
    if (restartTimer && typeof restartTimer.unref === "function") restartTimer.unref();
  }

  // 健康检查：进程在但连续 ping 失败 → 视为僵死，杀掉重拉；
  // 收养进程（无 watch 退出监听的旧 bridge）消失时也走保活重启
  async function healthTick() {
    if (gaveUp || restartTimer) return;
    if (opts.isManualStopped && opts.isManualStopped()) return;
    const pid = opts.getPid ? opts.getPid() : watchedPid;
    if (!pid) {
      if (!watchedPid && lastSeenPid) {
        log(`[bridge] 收养的 bridge 进程消失（原 pid=${lastSeenPid}）`);
        lastSeenPid = null;
        scheduleRestart("收养进程消失");
      }
      return; // 已 watch 的进程退出由退出监听接管
    }
    lastSeenPid = pid;
    let alive = false;
    try { await opts.ping(); alive = true; } catch { alive = false; }
    if (alive) { pingFails = 0; return; }
    pingFails++;
    if (pingFails < pingFailThreshold) return;
    pingFails = 0;
    log(`[bridge] 健康检查连续 ${pingFailThreshold} 次失败且进程仍在(pid=${pid})，视为僵死，杀掉重拉`);
    try { await opts.stop(); } catch {}
    scheduleRestart("健康检查判定僵死");
  }

  function startHealthLoop() {
    if (healthTimer) return;
    healthTimer = setIntervalFn(() => { healthTick().catch(() => {}); }, healthIntervalMs);
    if (healthTimer && typeof healthTimer.unref === "function") healthTimer.unref();
  }

  // _state 仅供验证脚本读取内部状态
  return { watch, onExit, healthTick, startHealthLoop, backoffDelay,
           _state: () => ({ attempts, gaveUp, pingFails, watchedPid, lastSeenPid, restartPending: !!restartTimer }) };
}
