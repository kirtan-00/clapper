// The router. It maps one route to one screen and nothing else — the nav state
// lives in ui/nav.ts, the chrome around it in ui/AppShell.tsx.
//
// The Projects stack (projects → project → shots / cliplog → rolling) predates
// the shell and keeps its own narrow callback props, so each screen still only
// knows the one move it is allowed to make. The three new tabs take the `nav`
// object whole, because they are the ones that will need to go anywhere.

import { AppShell } from './ui/AppShell';
import { enterSlate, type Nav, type Route } from './ui/nav';
import { HomeScreen } from './ui/HomeScreen';
import { SettingsScreen } from './ui/SettingsScreen';
import { AccountScreen } from './ui/AccountScreen';
import { ProjectsScreen } from './ui/ProjectsScreen';
import { ProjectScreen } from './ui/ProjectScreen';
import { ShotsScreen } from './ui/ShotsScreen';
import { ClipLogScreen } from './ui/ClipLogScreen';
import { RollingScreen } from './ui/RollingScreen';
import './styles.css';

/**
 * What a screen is CALLED when it is the thing you are going back to. iOS
 * labels a back button with the previous screen's name rather than leaving a
 * bare chevron, and only the router knows what that screen is.
 */
function labelFor(route: Route | undefined): string {
  switch (route?.name) {
    case 'home':
      return 'Home';
    case 'projects':
      return 'Projects';
    case 'settings':
      return 'Settings';
    case 'account':
      return 'Account';
    case 'project':
      return route.project.name;
    case 'shots':
    case 'rolling':
      return route.slate.name;
    case 'cliplog':
      return 'Clip log';
    default:
      return 'Back';
  }
}

function renderRoute(route: Route, nav: Nav) {
  switch (route.name) {
    case 'home':
      return <HomeScreen nav={nav} />;

    case 'settings':
      return <SettingsScreen nav={nav} />;

    case 'account':
      return <AccountScreen nav={nav} />;

    case 'projects':
      return <ProjectsScreen onOpen={(project) => nav.push({ name: 'project', project })} />;

    case 'project':
      return (
        <ProjectScreen
          project={route.project}
          backLabel={labelFor(nav.previous)}
          onBack={() => nav.pop()}
          onProjectChanged={(project) => nav.replace({ name: 'project', project })}
          onOpenSlate={(project, slate) => nav.push(enterSlate(project, slate))}
          onOpenClipLog={() => nav.push({ name: 'cliplog', project: route.project })}
        />
      );

    case 'cliplog':
      // Back lands wherever you opened it from — the project screen or the
      // rolling screen — because the stack under it is that screen.
      return (
        <ClipLogScreen
          project={route.project}
          backLabel={labelFor(nav.previous)}
          onBack={() => nav.pop()}
        />
      );

    case 'shots':
      return (
        <ShotsScreen
          project={route.project}
          slate={route.slate}
          backLabel={labelFor(nav.previous)}
          onBack={() => nav.pop()}
          onOpenShot={(shot) =>
            nav.push({ name: 'rolling', project: route.project, slate: route.slate, shot })
          }
        />
      );

    case 'rolling':
      return (
        <RollingScreen
          project={route.project}
          slate={route.slate}
          shot={route.shot}
          // Back goes to whichever list you came through: the shot list for a
          // scene with a breakdown, the scene list for one without. The stack
          // already holds that, so this is just a pop now.
          onExit={() => nav.pop()}
          // Moving to a DIFFERENT scene is sideways, not deeper: unwind to the
          // project screen first, so BACK out of the new scene means "the scene
          // list", not "the scene I was in before".
          onNavigate={(slate) => {
            nav.popTo('project');
            nav.push(enterSlate(route.project, slate));
          }}
          // A different shot in the SAME scene is the same depth.
          onNavigateShot={(shot) =>
            nav.replace({ name: 'rolling', project: route.project, slate: route.slate, shot })
          }
          onOpenClipLog={() => nav.push({ name: 'cliplog', project: route.project })}
        />
      );
  }
}

export default function App() {
  return <AppShell render={renderRoute} />;
}
