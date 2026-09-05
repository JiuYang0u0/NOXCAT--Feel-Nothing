"""在 dev/build 真實 Phaser 模擬完整戰鬥，不注入能量、傷害、生命或無敵。

使用既有安全通道選擇移動目標、合成 pointer 拉弓事件；以固定 60 FPS
推進遊戲 Clock 與 update。此測試檢查基準節奏，不代表真人平均通關時間。
"""

import argparse
import json
from pathlib import Path
from playwright.sync_api import sync_playwright


def open_game(browser, url):
    context = browser.new_context(viewport={"width": 390, "height": 844}, is_mobile=True, has_touch=True)
    page = context.new_page()
    errors = []
    page.on("pageerror", lambda error: errors.append(str(error)))
    page.route("**/api/**", lambda route: route.abort())
    page.goto(url)
    page.evaluate("""() => {
        const Game = window.Phaser.Game;
        window.Phaser.Game = class extends Game {
            constructor(...args) { super(...args); window.__attackQA = this; }
        };
    }""")
    page.get_by_test_id("quick-需求一直改").click()
    page.get_by_test_id("generate-boss").click()
    page.get_by_test_id("skip-camera").click()
    page.wait_for_function("window.__attackQA?.scene.getScene('BattleScene')?.session.state === 'DODGING'")
    return context, page, errors


def verify_controls(browser, url, engine, output):
    context, page, errors = open_game(browser, url)
    page.evaluate("window.__attackQA.scene.getScene('BattleScene').director.cancelCurrent()")
    page.keyboard.down("ArrowDown")
    page.wait_for_timeout(1000)
    page.keyboard.up("ArrowDown")
    sample = """() => {
        const s=window.__attackQA.scene.getScene('BattleScene');
        return {x:s.noxcat.x,y:s.noxcat.y,view:s.viewportLayout,state:s.session.state};
    }"""
    value = page.evaluate(sample)
    assert 773 <= value["y"] <= 774, value
    view = value["view"]
    x = (value["x"] - view["left"]) * view["zoom"]
    y = (value["y"] - view["top"]) * view["zoom"]
    cdp = context.new_cdp_session(page) if engine == "chromium" else None

    def gesture(start_y, end_y, release=True):
        if cdp:
            cdp.send("Input.dispatchTouchEvent", {"type": "touchStart", "touchPoints": [{"x": x, "y": start_y}]})
            cdp.send("Input.dispatchTouchEvent", {"type": "touchMove", "touchPoints": [{"x": x, "y": end_y}]})
        else:
            page.mouse.move(x, start_y)
            page.mouse.down()
            page.mouse.move(x, end_y, steps=6)
        page.wait_for_timeout(350)
        if release:
            if cdp:
                cdp.send("Input.dispatchTouchEvent", {"type": "touchEnd", "touchPoints": []})
            else:
                page.mouse.up()

    gesture(y, 838)
    page.wait_for_timeout(300)
    assert 773 <= page.evaluate(sample)["y"] <= 774
    page.evaluate("""() => {
        const s=window.__attackQA.scene.getScene('BattleScene');
        s.session.setEnergyForDebug(100);s.openVulnerability();
    }""")
    gesture(y, 838, release=False)
    aiming = page.evaluate(sample)
    assert aiming["state"] == "AIMING" and aiming["y"] <= 774, aiming
    assert page.evaluate("document.documentElement.scrollWidth<=innerWidth+1 && document.documentElement.scrollHeight<=innerHeight+1")
    output.mkdir(parents=True, exist_ok=True)
    page.screenshot(path=str(output / f"{engine}-bottom-boundary.png"))
    assert not errors, errors
    context.close()


SIM = r'''({graze, reflect, launch}) => {
 const s=window.__attackQA.scene.getScene('BattleScene');
 s.scene.pause(); s.audio.setEnabled(false);
 let ticks=0,lastPattern='',anchor={x:270,y:740},aimMs=0,launches=[];
 let homingMoved=false,waves=[];
 const point=(x,y)=>({id:1,x:(x-s.viewportLayout.left)*s.viewportLayout.zoom,y:(y-s.viewportLayout.top)*s.viewportLayout.zoom});
 for(;ticks<6000 && !['WON','LOST'].includes(s.session.state);ticks++) {
  const dt=1000/60, state=s.session.state;
  if(state==='DODGING') {
   const pattern=s.director.currentPattern;
   if(pattern!==lastPattern) {lastPattern=pattern;homingMoved=false;anchor={x:s.noxcat.x,y:s.noxcat.y};waves.push({pattern,time:s.session.elapsedMs,energy:s.session.energy});}
   const lane=s.director.currentSafeLane, spot=s.director.currentSafeSpot;
   let x=spot?.x??anchor.x, y=spot?.y??anchor.y;
   if(lane?.axis==='vertical') x=lane.center + graze;
   if(lane?.axis==='horizontal') y=lane.center;
   if(pattern==='revision_homing') {
    homingMoved ||= s.projectiles.activeProjectiles().some(p=>p.kind==='homing'&&p.homingRemainingMs<=0);
    if(homingMoved) x=Math.max(46,Math.min(494,anchor.x+(anchor.x>=270?-180:180)));
   }
   const green=s.projectiles.activeProjectiles().find(p=>p.reflectable&&!p.friendly&&p.isDamage&&p.tunnelDepth>0.55);
   if(green && reflect) {
    const side=s.noxcat.x<green.visibleCenterX?1:-1;
    x=green.visibleCenterX+side*100;y=green.visibleCenterY;
   }
   s.noxcat.beginDrag(); s.noxcat.setPointerTarget(x,y+72);
  } else if(state==='VULNERABLE' && launch) {
   s.activePointerId=null;
   const p=point(s.noxcat.x,s.noxcat.y);
   s.input.emit('pointerdown',p);
   const dx=s.noxcat.x-s.boss.x,dy=s.noxcat.y-(s.boss.y-13),d=Math.hypot(dx,dy);
   s.qaPull=point(s.noxcat.x+dx/d*150,s.noxcat.y+dy/d*150);
   s.input.emit('pointermove',s.qaPull); aimMs=0;
  } else if(state==='AIMING') {
   aimMs+=dt;
   if(aimMs>=650) {s.input.emit('pointerup',s.qaPull);launches.push(s.session.elapsedMs);}
  }
  s.time.preUpdate();s.time.update(s.time.now+dt,dt);s.update(s.time.now,dt);
 }
 return {...s.session.snapshot(),launches,waves};
}'''

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url", default="http://127.0.0.1:4173")
    parser.add_argument("--engine", choices=["chromium", "webkit", "both"], default="both")
    parser.add_argument("--webkit-executable", help="使用本機已安裝的 WebKit 執行檔")
    parser.add_argument("--output", default="tmp/balance-qa")
    args = parser.parse_args()
    results = []
    output = Path(args.output)
    with sync_playwright() as playwright:
        for engine in (["chromium", "webkit"] if args.engine == "both" else [args.engine]):
            options = {"executable_path": args.webkit_executable} if engine == "webkit" and args.webkit_executable else {}
            browser = getattr(playwright, engine).launch(**options)
            for name, graze, reflect in [("graze", 35, False), ("reflect", 35, True), ("passive", 0, False)]:
                context, page, errors = open_game(browser, args.url)
                result = page.evaluate(SIM, {"graze": graze, "reflect": reflect, "launch": name != "passive"})
                result.update({"profile": name, "engine": engine})
                if name == "passive":
                    assert result["state"] == "LOST" and result["elapsedMs"] == 90000, result
                else:
                    assert result["state"] == "WON", result
                    assert result["mainAttackHits"] == 4, result
                    assert 50000 <= result["elapsedMs"] <= 65000, result
                    if reflect:
                        assert result["reflectCount"] >= 1, result
                assert not errors, errors
                results.append(result)
                print(json.dumps({k: v for k, v in result.items() if k != "waves"}, ensure_ascii=False), flush=True)
                context.close()
            verify_controls(browser, args.url, engine, output)
            print(json.dumps({"engine": engine, "keyboard_drag_aim_boundary": "pass"}), flush=True)
            browser.close()
    output.mkdir(parents=True, exist_ok=True)
    (output / "balance-results.json").write_text(json.dumps(results, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
