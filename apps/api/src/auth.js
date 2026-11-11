import { getAuth } from 'firebase-admin/auth';

export async function requireAuth(req, res, next) {
  const token = req.get('authorization')?.replace(/^Bearer\s+/i, '');
  if (!token) return res.status(401).json({ error: 'Authentication required' });
  try {
    const identity = await getAuth().verifyIdToken(token);
    req.userId = identity.uid;
    req.userEmail = identity.email || '';
    req.userName = identity.name || '';
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired Firebase session' });
  }
}
