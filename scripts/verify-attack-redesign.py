"""本機實際 Phaser 波次、手機觸控勝利與 Chromium/WebKit 畫面驗證。"""

import argparse
import json
from pathlib import Path

from playwright.sync_api import sync_playwright


PATTERNS = ["paper_rain", "top_downpour", "comment_crossfire", "pulse_barrage",
            "alternating_zipper", "closing_walls", "revision_homing", "returnable_burst", "deadline_beam"]

SETUP = """async ({pattern, start, speed, seed}) => {
    const [{AttackDirector}, {SeededRng}, {GameSession}] = await Promise.all([
        import('/src/game/systems/AttackDirector.ts'), import('/src/utils/rng.ts'),
        import('/src/state/GameSession.ts')]);
    const s = window.__attackQA.scene.getScene('BattleScene');
    s.scene.pause(); s.director.cancelCurrent(); s.tweens.killAll();
    s.hud.clearFlash();
    s.hitReliefTimer?.remove(false);
    for (const p of s.projectiles.activeProjectiles()) p.recycle();
    s.projectiles.clearDangerous(false);
    s.session = new GameSession(); s.session.startBattle();
    s.noxcat.setPosition(start.x, start.y);
    s.noxcat.velocity.set(0, 0); s.noxcat.target.set(start.x, start.y);
    s.noxcat.mode = 'follow'; s.noxcat.cancelDrag();
    for (let i=0; i<100; i++) s.noxcat.updateMotion(1/60);
    s.director = new AttackDirector({attacks:[{pattern, intensity:3, durationMs:4500}]},
        new SeededRng(seed), s.projectiles, {scene:s, player:s.noxcat,
        getPlayerPosition:()=>({x:s.noxcat.x,y:s.noxcat.y}),
        onDangerZonesChanged:(zones)=>s.paintDangerZones(zones),
        onWavePhaseChanged:(phase, pattern, _volley, _lane, zones)=> {
            s.paintDangerZones(zones); s.waveGuide.setAlpha(phase === 'TELEGRAPH' ? 1 : 0.35);
        }});
    s.director.setPacingScale({speedScale:speed,telegraphScale:speed>1?0.7:1,
        recoveryScale:1,vulnerableScale:1,combatScale:1,urgency:0,relief:0});
    s.director.start(); s.qaTime=0; s.qaStart=start; s.qaHomingMoved=false;
    s.qaStats={pattern,start,speed,seed,peak:0,spawned:0,dropped:0};
    if(!s.qaOriginalSpawn) {
        s.qaOriginalSpawn=s.projectiles.spawn.bind(s.projectiles);
        s.projectiles.spawn=(config)=>{
            const card=s.qaOriginalSpawn(config);
            s.qaStats.spawned++;
            if(!card) s.qaStats.dropped++;
            return card;
        };
    }
    s.hud.setStateMessage(pattern==='closing_walls'?'跟著缺口移動':'離開紅色區域', pattern!=='closing_walls');
    s.hud.update(s.session.snapshot(), null);
    return {lane:s.director.currentSafeLane,spot:s.director.currentSafeSpot};
}"""

STEP = """({frames,fps}) => {
    const s=window.__attackQA.scene.getScene('BattleScene'), dt=1/fps;
    for(let i=0;i<frames;i++) {
        s.qaTime+=dt*1000;
        if(s.qaTime>=300) {
            const lane=s.director.currentSafeLane, spot=s.director.currentSafeSpot;
            let x=spot?.x??s.qaStart.x, y=spot?.y??s.qaStart.y;
            if(lane?.axis==='vertical') x=lane.center;
            if(lane?.axis==='horizontal') y=lane.center;
            if(s.director.currentPattern==='revision_homing') {
                const locked=s.projectiles.activeProjectiles().some(p=>p.kind==='homing'&&p.homingRemainingMs<=0);
                s.qaHomingMoved ||= locked;
                if(s.qaHomingMoved) {
                    x=Math.max(46,Math.min(494,s.qaStart.x+(s.qaStart.x>=270?-180:180)));
                }
            }
            s.noxcat.beginDrag(); s.noxcat.setPointerTarget(x,y+72);
        }
        const previous={x:s.noxcat.x,y:s.noxcat.y};
        s.noxcat.updateMotion(dt); s.session.advanceTime(dt*1000);
        s.handleBeamCollisions(previous);
        s.projectiles.update(dt,s.noxcat,1);
        s.handleProjectileCollisions(previous,dt*1000);
        s.session.setEnergyForDebug(0);
        s.director.update(dt*1000,3);
        s.qaStats.peak=Math.max(s.qaStats.peak,s.projectiles.activeProjectiles().length+s.projectiles.activeBeams().length);
        s.hud.update(s.session.snapshot(),null);
        if(s.session.lives<3) return {...s.qaStats,lives:s.session.lives,time:s.qaTime,
            player:{x:s.noxcat.x,y:s.noxcat.y},phase:s.director.currentPhase};
        if(s.director.currentPhase==='RECOVERY') return {...s.qaStats,lives:s.session.lives,time:s.qaTime,done:true};
    }
    return {...s.qaStats,lives:s.session.lives,time:s.qaTime};
}"""


def open_game(browser, url):
    context = browser.new_context(viewport={"width": 390, "height": 844}, is_mobile=True, has_touch=True)
    page = context.new_page()
    errors = []
    page.on("pageerror", lambda error: errors.append(str(error)))
    page.route("**/api/**", lambda route: route.abort())
    page.goto(url + "/?capture=1")
    page.evaluate("""() => { const Game=window.Phaser.Game;
        window.Phaser.Game=class extends Game {constructor(...args){super(...args);window.__attackQA=this;}};
    }""")
    page.get_by_test_id("quick-需求一直改").click()
    page.get_by_test_id("generate-boss").click()
    page.get_by_test_id("skip-camera").click()
    page.wait_for_function("window.__NOXCAT_TEST__?.snapshot().state==='DODGING'")
    page.wait_for_timeout(300)  # 等登場文字的 220 ms 淡出完成再暫停模擬。
    assert page.evaluate("document.documentElement.scrollWidth<=innerWidth+1 && document.documentElement.scrollHeight<=innerHeight+1")
    return context, page, errors


def capture(page, path):
    # Canvas 的場景資料更新後，等兩個瀏覽器影格完成實際繪製再截圖。
    page.evaluate("() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))")
    page.screenshot(path=str(path))


def verify_waves(browser, url, engine, output, capture_only=False):
    context, page, errors = open_game(browser, url)
    checked = 0
    for fps in ([] if capture_only else [30, 60, 120]):
        for speed in [1, 1.75]:
            for start in [{"x": 46, "y": 430}, {"x": 270, "y": 657}, {"x": 494, "y": 774}]:
                for pattern in PATTERNS:
                    page.evaluate(SETUP, {"pattern": pattern, "start": start, "speed": speed, "seed": 31})
                    result = page.evaluate(STEP, {"frames": fps*10, "fps": fps})
                    assert result["lives"] == 3 and result.get("done"), result
                    assert result["peak"] > 0, result
                    assert result["dropped"] == 0, result
                    checked += 1
        print(json.dumps({"engine": engine, "fps": fps, "waves": checked, "status": "pass"}), flush=True)
    for pattern in PATTERNS:
        page.evaluate(SETUP, {"pattern": pattern, "start": {"x": 270, "y": 740}, "speed": 1, "seed": 31})
        capture(page, output / f"{engine}-{pattern}-warning.png")
        page.evaluate(STEP, {"frames": 112 if pattern != "deadline_beam" else 53, "fps": 60})
        capture(page, output / f"{engine}-{pattern}-active.png")
    assert not errors, errors
    context.close()
    return checked


def verify_win(browser, url, engine, output):
    context, page, errors = open_game(browser, url)
    page.evaluate("window.__NOXCAT_TEST__.pauseAttacksForVisualTest()")
    for hit in range(1, 5):
        page.wait_for_function("['DODGING','VULNERABLE'].includes(window.__NOXCAT_TEST__?.snapshot().state)")
        page.evaluate("window.__NOXCAT_TEST__.fillEnergy()")
        state = page.evaluate("({visual:window.__NOXCAT_TEST__.visualSnapshot(),view:window.__NOXCAT_TEST__.viewportSnapshot()})")
        box = page.locator("canvas").bounding_box()
        view, visual = state["view"], state["visual"]
        x = box["x"] + box["width"] * (visual["x"]-view["left"])/view["width"]
        y = box["y"] + box["height"] * (visual["y"]-view["top"])/view["height"]
        end_y = min(box["y"]+box["height"]-4, y+box["height"]*140/view["height"])
        if engine == "chromium":
            cdp = context.new_cdp_session(page)
            cdp.send("Input.dispatchTouchEvent", {"type": "touchStart", "touchPoints": [{"x": x, "y": y}]})
            for step in range(1, 8):
                cdp.send("Input.dispatchTouchEvent", {"type": "touchMove", "touchPoints": [{"x": x, "y": y+(end_y-y)*step/7}]})
            page.wait_for_function("window.__NOXCAT_TEST__.snapshot().state==='AIMING'")
            cdp.send("Input.dispatchTouchEvent", {"type": "touchEnd", "touchPoints": []})
            cdp.detach()
        else:
            page.mouse.move(x, y)
            page.mouse.down()
            page.mouse.move(x, end_y, steps=7)
            page.wait_for_function("window.__NOXCAT_TEST__.snapshot().state==='AIMING'")
            page.mouse.up()
        page.wait_for_function("hit => (window.__NOXCAT_TEST__?.snapshot().mainAttackHits??0)>=hit || document.querySelector('[data-testid=result-title]')?.textContent==='BOSS DEFEATED'", arg=hit)
    page.get_by_test_id("result-title").wait_for()
    assert page.get_by_test_id("result-title").inner_text() == "BOSS DEFEATED"
    page.screenshot(path=str(output / f"{engine}-victory.png"))
    page.get_by_test_id("retry").click()
    page.wait_for_function("window.__NOXCAT_TEST__?.snapshot().state==='INTRO'")
    assert not errors, errors
    context.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url", default="http://127.0.0.1:4173")
    parser.add_argument("--engine", choices=["chromium", "webkit", "both"], default="both")
    parser.add_argument("--output", default="tmp/attack-redesign")
    parser.add_argument("--executable", help="使用本機既有的瀏覽器執行檔")
    parser.add_argument("--capture-only", action="store_true", help="只重新擷取九招預警與攻擊畫面")
    args = parser.parse_args()
    output = Path(args.output)
    output.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as playwright:
        for engine in (["chromium", "webkit"] if args.engine == "both" else [args.engine]):
            browser = getattr(playwright, engine).launch(**({"executable_path": args.executable} if args.executable else {}))
            waves = verify_waves(browser, args.url, engine, output, args.capture_only)
            if not args.capture_only:
                verify_win(browser, args.url, engine, output)
            browser.close()
            print(json.dumps({"engine": engine, "waves": waves,
                              "fallback_victory_retry": "not_run" if args.capture_only else "pass"}), flush=True)


if __name__ == "__main__":
    main()
