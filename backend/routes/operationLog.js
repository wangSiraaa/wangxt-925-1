const express = require('express');
const router = express.Router();
const { tables } = require('../db/jsonDB');

router.get('/', (req, res) => {
  const { biz_type, biz_id, operator, page = 1, page_size = 50 } = req.query;
  const offset = (page - 1) * page_size;

  let list = tables.operation_log.all();

  if (biz_type) {
    list = list.filter(l => l.biz_type === biz_type);
  }
  if (biz_id) {
    list = list.filter(l => l.biz_id === biz_id);
  }
  if (operator) {
    list = list.filter(l => l.operator && l.operator.includes(operator));
  }

  list = list.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  const total = list.length;
  const pageList = list.slice(offset, offset + parseInt(page_size));

  res.json({
    code: 0,
    data: {
      list: pageList,
      total,
      page: parseInt(page),
      page_size: parseInt(page_size)
    }
  });
});

module.exports = router;
