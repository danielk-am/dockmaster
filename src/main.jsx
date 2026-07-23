import { createRoot } from 'react-dom/client';
import '@wordpress/components/build-style/style.css';
import './style.css';
import App from './App.jsx';

createRoot(document.getElementById('root')).render(<App />);
