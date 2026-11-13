import './install';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { loadBrand } from './brand';
import { startResponsiveTables } from './responsiveTables';
import './styles.css';

void loadBrand();
startResponsiveTables();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
