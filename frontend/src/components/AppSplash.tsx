import ClaudeLogo from '@/components/ClaudeLogo';

/**
 * Animated launch splash for the installed PWA (iPhone home screen), like the Finance app.
 * Server-rendered so it is on screen at the first paint. The inline head script (SPLASH_HEAD_SCRIPT)
 * sets html.splash-active only when the app runs standalone and only once per app session;
 * SPLASH_HIDE_SCRIPT fades it out after a short minimum time. The tile sits exactly where the
 * static apple-touch-startup-image draws it, so iOS' launch image flows straight into this.
 */
export default function AppSplash() {
  return (
    <div className="app-splash" id="appSplash" aria-hidden="true">
      <div className="app-splash-tile">
        <ClaudeLogo className="w-[62px] h-[62px]" />
      </div>
      <div className="app-splash-text">
        <div className="app-splash-name">Claude Code</div>
        <div className="app-splash-bar" />
      </div>
    </div>
  );
}

export const SPLASH_HEAD_SCRIPT =
  "(function(){try{var s=window.matchMedia('(display-mode: standalone)').matches||window.navigator.standalone===true;" +
  "if(s&&!sessionStorage.getItem('splashed')){document.documentElement.classList.add('splash-active');}}catch(e){}})();";

export const SPLASH_HIDE_SCRIPT =
  "(function(){var h=document.documentElement;if(!h.classList.contains('splash-active'))return;" +
  "var el=document.getElementById('appSplash'),MIN=1300,t0=Date.now(),done=false;" +
  "function hide(){if(done)return;done=true;try{sessionStorage.setItem('splashed','1')}catch(e){}" +
  "setTimeout(function(){if(el)el.classList.add('hide');setTimeout(function(){h.classList.remove('splash-active');},480);}," +
  "Math.max(0,MIN-(Date.now()-t0)));}" +
  "if(document.readyState==='complete')hide();else window.addEventListener('load',hide);setTimeout(hide,4000);})();";
