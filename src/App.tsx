import { useState } from 'react';
import type { Project, Shot, Slate } from './types';
import { ProjectsScreen } from './ui/ProjectsScreen';
import { ProjectScreen } from './ui/ProjectScreen';
import { ShotsScreen } from './ui/ShotsScreen';
import { ClipLogScreen } from './ui/ClipLogScreen';
import { RollingScreen } from './ui/RollingScreen';
import './styles.css';

type Screen =
  | { name: 'projects' }
  | { name: 'project'; project: Project }
  // The shot list for one scene. Only reachable for scenes that HAVE shots —
  // a hand-made scene goes straight from the project screen to rolling, as it
  // always has.
  | { name: 'shots'; project: Project; slate: Slate }
  // Every clip the project has rolled, flat and newest-first. Project-wide by
  // nature (you look a clip up by name, not by remembering its scene), so it
  // carries the project only and backs out to the project screen.
  | { name: 'cliplog'; project: Project }
  // `shot` is absent when the scene has no breakdown: takes then log against
  // the scene itself, exactly as before shots existed.
  | { name: 'rolling'; project: Project; slate: Slate; shot?: Shot };

/** A scene with a breakdown opens its shot list; a bare scene opens rolling. */
function enterSlate(project: Project, slate: Slate): Screen {
  return slate.shots?.length
    ? { name: 'shots', project, slate }
    : { name: 'rolling', project, slate };
}

export default function App() {
  const [screen, setScreen] = useState<Screen>({ name: 'projects' });

  switch (screen.name) {
    case 'projects':
      return (
        <ProjectsScreen onOpen={(project) => setScreen({ name: 'project', project })} />
      );

    case 'project':
      return (
        <ProjectScreen
          project={screen.project}
          onBack={() => setScreen({ name: 'projects' })}
          onProjectChanged={(project) => setScreen({ name: 'project', project })}
          onOpenSlate={(project, slate) => setScreen(enterSlate(project, slate))}
          onOpenClipLog={() => setScreen({ name: 'cliplog', project: screen.project })}
        />
      );

    case 'cliplog':
      return (
        <ClipLogScreen
          project={screen.project}
          onBack={() => setScreen({ name: 'project', project: screen.project })}
        />
      );

    case 'shots':
      return (
        <ShotsScreen
          project={screen.project}
          slate={screen.slate}
          onBack={() => setScreen({ name: 'project', project: screen.project })}
          onOpenShot={(shot) =>
            setScreen({ name: 'rolling', project: screen.project, slate: screen.slate, shot })
          }
        />
      );

    case 'rolling':
      return (
        <RollingScreen
          project={screen.project}
          slate={screen.slate}
          shot={screen.shot}
          // Back goes to whichever list you came through: the shot list for a
          // scene with a breakdown, the scene list for one without.
          onExit={() =>
            setScreen(
              screen.slate.shots?.length
                ? { name: 'shots', project: screen.project, slate: screen.slate }
                : { name: 'project', project: screen.project },
            )
          }
          onNavigate={(slate) => setScreen(enterSlate(screen.project, slate))}
          onNavigateShot={(shot) =>
            setScreen({ name: 'rolling', project: screen.project, slate: screen.slate, shot })
          }
        />
      );
  }
}
