import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { Root } from './Root';
import './styles.css';
import { startUiLog } from './uiLog';

const root = document.getElementById('root');

if (root === null) {
  throw new Error('#root missing from index.html');
}

startUiLog();

createRoot(root).render(
  <StrictMode>
    <Root />
  </StrictMode>
);
