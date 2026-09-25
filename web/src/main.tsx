import { createRoot } from 'react-dom/client';
import App from './App';
import './styles/tokens.css';
import './styles/answer-input.css';
import './styles/base.css';

const host = document.getElementById('root');
if (!host) throw new Error('index.html 缺少 #root 容器');

createRoot(host).render(<App />);
