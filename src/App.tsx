import { useState } from 'react';
import type { Project, Slate } from './types';
import { ProjectsScreen } from './ui/ProjectsScreen';
import { ProjectScreen } from './ui/ProjectScreen';
import { RollingScreen } from './ui/RollingScreen';
import './styles.css';

type Screen =
  | { name: 'projects' }
  | { name: 'project'; project: Project }
  | { name: 'rolling'; project: Project; slate: Slate };

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
          onOpenSlate={(project, slate) => setScreen({ name: 'rolling', project, slate })}
        />
      );

    case 'rolling':
      return (
        <RollingScreen
          project={screen.project}
          slate={screen.slate}
          onExit={() => setScreen({ name: 'project', project: screen.project })}
          onNavigate={(slate) => setScreen({ name: 'rolling', project: screen.project, slate })}
        />
      );
  }
}
