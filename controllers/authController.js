const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const pool = require('../db');


exports.signInTeacher = async (req, res) => {
    const { email, password } = req.body;

    try {
        const [[staff]] = await pool.query('SELECT * FROM staff WHERE email = ?', [email]);

        if (!staff) {
            return res.status(401).json({ message: 'Invalid email or password' });
        }

        const isMatch = await bcrypt.compare(password, staff.password);
        if (!isMatch) {
            return res.status(401).json({ message: 'Invalid email or password' });
        }

        const accessToken = jwt.sign({ id: staff.id, email: staff.email }, process.env.JWT_SECRET, { expiresIn: '7d' });
        const refreshToken = jwt.sign({ id: staff.id, email: staff.email }, process.env.JWT_REFRESH_SECRET, { expiresIn: '7d' });

        await pool.query('UPDATE staff SET refresh_token = ? WHERE id = ?', [refreshToken, staff.id]);

        res.json({
            accessToken,
            refreshToken,
            id: staff.id,
            name: staff.name,
            lastname: staff.lastname,
            email: staff.email,
            role: staff.role,
        });
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Error signing in', error: error.sqlMessage });
    }
};

exports.refreshToken = async (req, res) => {
    const { token } = req.body;

    if (!token) {
        return res.sendStatus(401);
    }

    try {
        jwt.verify(token, process.env.JWT_REFRESH_SECRET, async (err, user) => {
            if (err) return res.sendStatus(403);

            const [[staff]] = await pool.query('SELECT * FROM staff WHERE id = ?', [user.id]);

            if (!staff || staff.refresh_token !== token) {
                return res.sendStatus(403);
            }

            // Generate a new access token
            const accessToken = jwt.sign({ id: user.id, email: user.email }, process.env.JWT_SECRET, { expiresIn: '7d' });

            res.json({ accessToken });
        });
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Error refreshing token', error: error.sqlMessage });
    }
};

exports.userInit = async (req, res) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ message: 'Unauthorized' }); // No token provided
    }
    const token = authHeader.split(' ')[1]; // Extract token
    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        console.log('decoded',decoded)
        const [[staff]] = await pool.query('SELECT * FROM staff WHERE id = ?', [decoded.id]);
        if (!staff) {
            return res.status(404).json({ message: 'admin not found' });
        }
        res.json({
            id: staff.id,
            name: staff.name,
            lastname: staff.lastname,
            email: staff.email,
            role: staff.role,
        });
    } catch (error) {
        console.error(error);
        return res.status(401).json({ message: 'Unauthorized' }); // Invalid token
    }
};

exports.users = async (req, res) => {
    const authHeader = req.headers.authorization;
    // if (!authHeader || !authHeader.startsWith('Bearer ')) {
    //     return res.status(401).json({ message: 'Unauthorized' }); // No token provided
    // }
    try {
        const [users] = await pool.query('SELECT * FROM users ');
        if (!users) {
            return res.status(404).json({ message: 'admin not found' });
        }
        res.json(users);
    } catch (error) {
        console.error(error);
        return res.status(401).json({ message: 'Unauthorized' }); // Invalid token
    }
};

exports.orders = async (req, res) => {
    const authHeader = req.headers.authorization;
    // if (!authHeader || !authHeader.startsWith('Bearer ')) {
    //     return res.status(401).json({ message: 'Unauthorized' }); // No token provided
    // }
    try {
        const [orders] = await pool.query('SELECT * FROM orders ORDER BY c_date DESC');
        if (!orders) {
            return res.status(404).json({ message: 'admin not found' });
        }

        const parsedOrders = orders.map(order => {
            let parsedPackage;

            try {
                parsedPackage = JSON.parse(order.package);
            } catch (e) {
                parsedPackage = {}; // or null / order.package if invalid JSON
            }

            return {
                ...order,
                package: parsedPackage
            };
        });
        res.json(parsedOrders);
    } catch (error) {
        console.error(error);
        return res.status(401).json({ message: 'Unauthorized' }); // Invalid token
    }
};

exports.ordersById = async (req, res) => {
    const orderId = req.params.id; // Get the ID from the route parameter

    // Optional: You can enable this if you plan to use authorization
    // const authHeader = req.headers.authorization;
    // if (!authHeader || !authHeader.startsWith('Bearer ')) {
    //     return res.status(401).json({ message: 'Unauthorized' });
    // }

    try {
        const [orders] = await pool.query(
            'SELECT * FROM orders WHERE id = ? ORDER BY c_date DESC',
            [orderId]
        );

        if (!orders || orders.length === 0) {
            return res.status(404).json({ message: 'Order not found' });
        }

        const parsedOrders = orders.map(order => {
            let parsedPackage;

            try {
                parsedPackage = JSON.parse(order.package);
            } catch (e) {
                parsedPackage = {};
            }

            return {
                ...order,
                package: parsedPackage
            };
        });

        res.json(parsedOrders);
    } catch (error) {
        console.error(error);
        return res.status(500).json({ message: 'Server error' });
    }
};

exports.ordersByUsers = async (req, res) => {
    const userId = req.params.id; // Get the ID from the route parameter

    // Optional: You can enable this if you plan to use authorization
    // const authHeader = req.headers.authorization;
    // if (!authHeader || !authHeader.startsWith('Bearer ')) {
    //     return res.status(401).json({ message: 'Unauthorized' });
    // }

    try {
        const [orders] = await pool.query(
            'SELECT * FROM orders WHERE user_id = ? ORDER BY c_date DESC',
            [userId]
        );
        const [users] = await pool.query(
            'SELECT * FROM users WHERE id = ?',
            [userId]
        );

        if (!orders || orders.length === 0) {
            return res.status(404).json({ message: 'Order not found' });
        }

        const parsedOrders = orders.map(order => {
            let parsedPackage;

            try {
                parsedPackage = JSON.parse(order.package);
            } catch (e) {
                parsedPackage = {};
            }

            return {
                ...order,
                package: parsedPackage,

            };
        });

        res.json({orders:parsedOrders,users:users});
    } catch (error) {
        console.error(error);
        return res.status(500).json({ message: 'Server error' });
    }
};




exports.overview = async (req, res) => {
    try {
        const [orders] = await pool.query(
            `SELECT * FROM orders 
             WHERE c_date >= DATE_SUB(CURDATE(), INTERVAL 7 DAY) 
             ORDER BY c_date DESC`
        );

        const parsedOrders = orders.map(order => {
            let parsedPackage;
            try {
                parsedPackage = JSON.parse(order.package);
            } catch (e) {
                parsedPackage = {};
            }
            return {
                ...order,
                package: parsedPackage,
            };
        });

        const [[{ totalUsers }]] = await pool.query(
            'SELECT COUNT(*) AS totalUsers FROM users'
        );

        const [[{ todayOrders }]] = await pool.query(
            `SELECT COUNT(*) AS todayOrders
             FROM orders
             WHERE DATE(c_date) = CURDATE()`
        );

        const [[{ totalOrders }]] = await pool.query(
            `SELECT COUNT(*) AS totalOrders FROM orders`
        );

        res.json({
            orders: parsedOrders,
            stats: {
                totalUsers,
                totalOrders,
                todayOrders,
            }
        });

    } catch (error) {
        console.error(error);
        return res.status(500).json({ message: 'Server error' });
    }
};

